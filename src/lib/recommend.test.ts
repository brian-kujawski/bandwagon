import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { callsThisMonth } from "./budget";
import { openDb, type Db } from "./db";
import { ingestJamBase } from "./ingest";
import type { JbEvent } from "./jambase";
import { recommendForProfile } from "./recommend";
import { setPref } from "./prefs";

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

let n = 0;
const mbid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;

const concert = (date: string, ...acts: [string, string][]) => ({
  "@type": "Concert",
  identifier: `jambase:e${++n}`,
  startDate: `${date}T20:00:00`,
  performer: acts.map(([id, name], i) => ({ identifier: `jambase:${id}`, name, "x-isHeadliner": i === 0 })),
});

const NOW = new Date("2026-10-09T12:00:00Z");
const fetchMock = vi.fn<typeof fetch>();
let db: Db;

beforeEach(() => {
  db = openDb(":memory:");
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("JAMBASE_API_KEY", "test-key");
  vi.stubEnv("BANDWAGON_EXPAND", "0");
  vi.spyOn(console, "info").mockImplementation(() => {});
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("recommendForProfile", () => {
  it("checks a few liked bands per visit and counts every call", async () => {
    vi.stubEnv("BANDWAGON_REFRESH_PER_VISIT", "2");
    const names = new Map<string, [string, string]>();
    for (const [i, name] of ["Alpha", "Bravo", "Charlie"].entries()) {
      const id = mbid();
      names.set(id, [String(i + 1), name]);
      setPref(db, { name, mbid: id }, "liked");
    }
    // Each band opens for Zulu on its own date.
    fetchMock.mockImplementation(async (url) => {
      const id = new URL(String(url)).searchParams.get("artistId")!.replace("musicbrainz:", "");
      const day = names.get(id)![0];
      return json({ events: [concert(`2026-11-0${day}`, ["9", "Zulu"], names.get(id)!)] });
    });

    const first = await recommendForProfile(db, NOW);
    expect(first.liked).toBe(3);
    expect(first.refreshed).toHaveLength(2);
    expect(first.waiting).toBe(1);
    expect(callsThisMonth(db, "jambase", NOW)).toBe(2);
    expect(first.results.candidates.map((c) => c.artist.name)).toEqual(["Zulu"]);
    expect(first.results.candidates[0].direct).toHaveLength(2);

    const second = await recommendForProfile(db, NOW);
    expect(second.refreshed).toHaveLength(1);
    expect(second.waiting).toBe(0);

    const third = await recommendForProfile(db, NOW);
    expect(third.refreshed).toHaveLength(0);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("stops before the monthly budget", async () => {
    vi.stubEnv("JAMBASE_MONTHLY_BUDGET", "2");
    setPref(db, { name: "Alpha", mbid: mbid() }, "liked");
    const out = await recommendForProfile(db, NOW);
    expect(out.refreshed).toHaveLength(0);
    expect(out.waiting).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(out.budget).toEqual({ used: 0, limit: 2 });
  });

  it("leaves out bands you're not interested in, but still links through them", async () => {
    setPref(db, { name: "Alpha", mbid: mbid() }, "liked");
    setPref(db, { name: "Bravo", jambaseId: "jambase:2" }, "not_interested");
    fetchMock.mockResolvedValueOnce(json({ events: [concert("2026-11-01", ["1", "Alpha"], ["2", "Bravo"])] }));
    await recommendForProfile(db, NOW);
    ingestJamBase(db, [concert("2026-11-05", ["2", "Bravo"], ["3", "Charlie"]) as JbEvent], {
      name: "Bravo",
      jambaseId: "jambase:2",
    });

    const out = await recommendForProfile(db, NOW);
    expect(out.results.candidates.map((c) => c.artist.name)).toEqual(["Charlie"]);
    expect(out.results.candidates[0].direct).toEqual([]);
  });

  it("doesn't look a band up again for a month when JamBase doesn't have it", async () => {
    setPref(db, { name: "Nobody", mbid: mbid() }, "liked");
    fetchMock.mockResolvedValueOnce(json({ events: [] })).mockResolvedValueOnce(json({ artists: [] }));
    const out = await recommendForProfile(db, NOW);
    expect(out.refreshed).toEqual([{ name: "Nobody", status: { kind: "not-on-jambase" } }]);
    await recommendForProfile(db, NOW);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reports a missing key without failing", async () => {
    vi.stubEnv("JAMBASE_API_KEY", "");
    setPref(db, { name: "Alpha", mbid: mbid() }, "liked");
    const out = await recommendForProfile(db, NOW);
    expect(out.noKey).toBe(true);
    expect(out.refreshed).toEqual([]);
  });
});

describe("nearby shows", () => {
  it("lists a suggestion's upcoming shows near Detroit", async () => {
    vi.stubEnv("JAMBASE_API_KEY", "");
    const id = mbid();
    setPref(db, { name: "Alpha", mbid: id }, "liked");
    const at = (latitude: number, longitude: number) => ({ name: "Venue", geo: { latitude, longitude } });
    ingestJamBase(
      db,
      [
        { ...concert("2026-11-01", ["1", "Alpha"], ["9", "Zulu"]), location: at(41.88, -87.63) }, // Chicago
        { ...concert("2026-11-02", ["1", "Alpha"], ["9", "Zulu"]), location: at(42.34, -83.05) }, // Detroit
      ] as JbEvent[],
      { name: "Alpha", mbid: id, jambaseId: "jambase:1" },
    );
    const out = await recommendForProfile(db, NOW);
    expect(out.results.candidates[0].artist.name).toBe("Zulu");
    expect(out.results.candidates[0].nearby.map((s) => s.date)).toEqual(["2026-11-02"]);
  });
});

describe("pages", () => {
  it("serves a ranked list a page at a time", async () => {
    vi.stubEnv("JAMBASE_API_KEY", "");
    const id = mbid();
    setPref(db, { name: "Alpha", mbid: id }, "liked");
    const acts: [string, string][] = Array.from({ length: 7 }, (_, i) => [String(100 + i), `Act ${i}`]);
    // Act i shares i + 1 dates with Alpha, so the order is Act 6 down to Act 0.
    const events = acts.flatMap((act, i) =>
      Array.from({ length: i + 1 }, (_, d) => concert(`2026-${String(i + 1).padStart(2, "0")}-${String(d + 1).padStart(2, "0")}`, ["1", "Alpha"], act)),
    );
    ingestJamBase(db, events as JbEvent[], { name: "Alpha", mbid: id, jambaseId: "jambase:1" });

    const first = await recommendForProfile(db, NOW, { size: 3 });
    expect(first.results.total).toBe(7);
    expect(first.results.candidates.map((c) => c.artist.name)).toEqual(["Act 6", "Act 5", "Act 4"]);
    const last = await recommendForProfile(db, NOW, { size: 3, page: 2 });
    expect(last.results.candidates.map((c) => c.artist.name)).toEqual(["Act 0"]);
  });
});
