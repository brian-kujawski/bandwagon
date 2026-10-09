import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { callsThisMonth, recordCalls, remainingCalls } from "./budget";
import { openDb, type Db } from "./db";
import { exportData, importData } from "./portable";
import { countPrefs, getPref, likeMany, listPrefs, namesFromList, setPref } from "./prefs";

const MBID = "11111111-1111-4111-8111-111111111111";

let db: Db;
beforeEach(() => {
  db = openDb(":memory:");
});

describe("band preferences", () => {
  it("saves likes and not-interested bands with no cap", () => {
    for (let i = 0; i < 500; i++) setPref(db, { name: `Band ${i}` }, "liked");
    setPref(db, { name: "Nope" }, "not_interested");
    expect(countPrefs(db, "liked")).toBe(500);
    expect(listPrefs(db, "liked", { limit: 2, offset: 1 }).map((p) => p.name)).toEqual(["Band 1", "Band 10"]);
    expect(getPref(db, { name: "nope" })).toBe("not_interested");
  });

  it("clears a band without forgetting that it was cleared", () => {
    setPref(db, { name: "PUP", mbid: MBID }, "liked");
    setPref(db, { name: "PUP", mbid: MBID.toUpperCase() }, "cleared");
    expect(getPref(db, { name: "PUP", mbid: MBID })).toBeNull();
    expect(countPrefs(db, "liked")).toBe(0);
  });

  it("moves a band saved by name onto its MusicBrainz ID", () => {
    setPref(db, { name: "PONY", jambaseId: "jambase:5" }, "liked");
    setPref(db, { name: "PONY", mbid: MBID }, "liked");
    expect(listPrefs(db, "liked")).toEqual([
      expect.objectContaining({ key: `mbid:${MBID}`, name: "PONY", mbid: MBID }),
    ]);
  });

  it("reads names from a list or CSV", () => {
    expect(namesFromList('artist,plays\n"PUP",12\nPONY\n\npup\nCharmer, 3\r\n')).toEqual(["PUP", "PONY", "Charmer"]);
  });

  it("likes many bands, skipping saved and ambiguous names", async () => {
    setPref(db, { name: "PUP" }, "liked");
    const search = vi.fn(async (name: string) =>
      ({
        PONY: [{ mbid: MBID, name: "PONY", disambiguation: "" }, { mbid: "x", name: "Pony Bradshaw", disambiguation: "" }],
        Low: [
          { mbid: "a", name: "Low", disambiguation: "US slowcore" },
          { mbid: "b", name: "Low", disambiguation: "other" },
        ],
      })[name] ?? [],
    );
    const r = await likeMany(db, ["PUP", "PONY", "Low", "Nobody"], search);
    expect(r).toEqual({ liked: ["PONY"], already: ["PUP"], ambiguous: [{ name: "Low", matches: 2 }], notFound: ["Nobody"] });
    expect(search).toHaveBeenCalledTimes(3);
    expect(getPref(db, { name: "PONY", mbid: MBID })).toBe("liked");

    const again = await likeMany(db, ["Low"], search, { takeFirst: true });
    expect(again.liked).toEqual(["Low"]);
    expect(getPref(db, { name: "Low", mbid: "a" })).toBe("liked");
  });
});

describe("budget", () => {
  it("counts calls per month and stops at the budget", () => {
    vi.stubEnv("JAMBASE_MONTHLY_BUDGET", "10");
    const oct = new Date("2026-10-09T00:00:00Z");
    recordCalls(db, "jambase", 4, oct);
    recordCalls(db, "jambase", 7, oct);
    recordCalls(db, "jambase", 2, new Date("2026-11-01T00:00:00Z"));
    expect(callsThisMonth(db, "jambase", oct)).toBe(11);
    expect(remainingCalls(db, "jambase", oct)).toBe(0);
    expect(remainingCalls(db, "jambase", new Date("2026-11-02T00:00:00Z"))).toBe(8);
    vi.unstubAllEnvs();
  });
});

describe("moving preferences between machines", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "bandwagon-prefs-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("keeps the newer choice for each band, removals included", () => {
    const windows = openDb(":memory:");
    const linux = openDb(":memory:");
    setPref(windows, { name: "PUP", mbid: MBID }, "liked", "2026-10-01T00:00:00Z");
    setPref(windows, { name: "Charmer" }, "liked", "2026-10-01T00:00:00Z");
    setPref(linux, { name: "PUP", mbid: MBID }, "cleared", "2026-10-05T00:00:00Z");
    setPref(linux, { name: "Charmer" }, "not_interested", "2026-09-01T00:00:00Z");
    setPref(linux, { name: "PONY" }, "liked", "2026-10-02T00:00:00Z");

    const file = path.join(dir, "linux.sqlite");
    exportData(linux, file);
    expect(importData(windows, file).prefsInFile).toBe(3);
    expect(getPref(windows, { name: "PUP", mbid: MBID })).toBeNull();
    expect(getPref(windows, { name: "Charmer" })).toBe("liked");
    expect(getPref(windows, { name: "PONY" })).toBe("liked");
  });

  it("adds up JamBase calls across machines without double counting", () => {
    const a = openDb(":memory:");
    const now = new Date();
    recordCalls(a, "jambase", 5, now);
    a.prepare("INSERT INTO api_calls (source, month, machine, calls) VALUES ('jambase', ?, 'other-pc', 3)").run(
      now.toISOString().slice(0, 7),
    );
    const file = path.join(dir, "a.sqlite");
    exportData(a, file);
    const b = openDb(":memory:");
    callsThisMonth(b, "jambase", now); // creates the table
    b.prepare("INSERT INTO api_calls (source, month, machine, calls) VALUES ('jambase', ?, 'other-pc', 6)").run(
      now.toISOString().slice(0, 7),
    );
    importData(b, file);
    importData(b, file);
    expect(callsThisMonth(b, "jambase", now)).toBe(11);
  });
});
