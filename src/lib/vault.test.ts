import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CaConcertRow } from "./concertArchives";
import { openDb, type Db } from "./db";
import { exportData, importData } from "./portable";
import { addPayload, importRawPages, performerLedger, rebuildConcertArchives } from "./vault";

const row = (date: string, title: string, slug: string, venue = "Venue"): CaConcertRow => ({ date, title, slug, venue });

const page = (n: number, hasNext: boolean, concerts: CaConcertRow[]) => ({
  page: n,
  has_next: hasNext,
  performer_slug: "pup--5",
  concerts,
});

const store = (db: Db, n: number, body: unknown, fetchedAt = "2026-10-01T00:00:00.000Z", slug = "pup--5") =>
  addPayload(db, {
    source: "parsebot",
    endpoint: "get_performer_concerts",
    params: { slug, page: String(n) },
    subject: "PUP",
    fetchedAt,
    credits: 2,
    body,
  });

const PAGE_1 = page(1, true, [
  row("Oct 29, 2026", "PUP / NoBro / PONY", "c1"),
  row("Oct 28, 2026", "PUP / NoBro / PONY", "c1-dupe"),
  row("Jul 20, 2026", "PUP", "c2"),
]);
const PAGE_2 = page(2, false, [
  row("May 02, 2025", "PUP / Pkew Pkew Pkew", "c3"),
  row("Jun 01, 2025", "Riot Fest 2025", "c4"),
]);

const coBilled = (db: Db) =>
  (
    db
      .prepare(
        `SELECT a.name FROM artists a JOIN appearances ap ON ap.artist_id = a.id
         JOIN events e ON e.id = ap.event_id WHERE e.source = 'concertarchives' ORDER BY a.name`,
      )
      .all() as { name: string }[]
  ).map((r) => r.name);

let dir: string;
let db: Db;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "bandwagon-vault-"));
  db = openDb(":memory:");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("vault", () => {
  it("stores a response once, however it is formatted", () => {
    expect(store(db, 1, PAGE_1)).toBe(true);
    expect(store(db, 1, JSON.stringify(PAGE_1, null, 2))).toBe(false);
    expect(store(db, 1, PAGE_1, "2026-11-01T00:00:00.000Z")).toBe(false);
  });

  it("rebuilds the graph and the ledger from stored pages", () => {
    store(db, 1, PAGE_1);
    store(db, 2, PAGE_2);
    expect(rebuildConcertArchives(db)).toEqual({ performers: 1, concerts: 5, shows: 3 });
    expect(coBilled(db)).toEqual(["NoBro", "NoBro", "PONY", "PONY", "PUP", "PUP", "PUP", "Pkew Pkew Pkew"]);
    expect(performerLedger(db)).toEqual([
      expect.objectContaining({
        slug: "pup--5",
        name: "PUP",
        pages: 2,
        max_page: 2,
        reached_end: 1,
        concerts: 5,
        oldest_date: "2025-05-02",
        newest_date: "2026-10-29",
        credits: 4,
      }),
    ]);
  });

  it("is safe to rebuild repeatedly", () => {
    store(db, 1, PAGE_1);
    rebuildConcertArchives(db);
    const first = coBilled(db);
    rebuildConcertArchives(db);
    expect(coBilled(db)).toEqual(first);
  });

  it("lets a newer copy of a concert replace an older one", () => {
    store(db, 1, PAGE_1);
    store(
      db,
      1,
      page(1, true, [row("Oct 29, 2026", "PUP / PONY / Charmer", "c1"), row("Jul 20, 2026", "PUP", "c2")]),
      "2026-11-01T00:00:00.000Z",
    );
    rebuildConcertArchives(db);
    const bill = db
      .prepare(
        `SELECT a.name FROM artists a JOIN appearances ap ON ap.artist_id = a.id
         JOIN events e ON e.id = ap.event_id WHERE e.source_id = 'c1' ORDER BY a.name`,
      )
      .all() as { name: string }[];
    expect(bill.map((r) => r.name)).toEqual(["Charmer", "PONY", "PUP"]);
  });
});

describe("importRawPages", () => {
  it("adds cached page files and names the performer from its summary", () => {
    const raw = path.join(dir, "raw");
    mkdirSync(path.join(raw, "pup--5"), { recursive: true });
    const file = path.join(raw, "pup--5", "concerts-page-1.json");
    writeFileSync(file, JSON.stringify(PAGE_1, null, 2));
    writeFileSync(path.join(raw, "pup--5", "notes.txt"), "ignored");
    writeFileSync(path.join(dir, "pup--5.json"), JSON.stringify({ seed: "PUP" }));
    utimesSync(file, new Date("2026-10-09T12:00:00Z"), new Date("2026-10-09T12:00:00Z"));

    expect(importRawPages(db, raw)).toEqual({ files: 1, added: 1 });
    expect(importRawPages(db, raw)).toEqual({ files: 1, added: 0 });
    rebuildConcertArchives(db);
    expect(performerLedger(db)[0]).toMatchObject({ name: "PUP", last_fetched_at: "2026-10-09T12:00:00.000Z" });
  });

  it("does nothing when there is no raw folder", () => {
    expect(importRawPages(db, path.join(dir, "missing"))).toEqual({ files: 0, added: 0 });
  });
});

describe("export and import", () => {
  it("merges two machines' vaults without losing either", () => {
    const windows = openDb(path.join(dir, "windows.db"));
    const linux = openDb(path.join(dir, "linux.db"));
    store(windows, 1, PAGE_1);
    store(linux, 2, PAGE_2);
    store(linux, 1, PAGE_1); // fetched on both

    const file = path.join(dir, "bandwagon-export.sqlite");
    expect(exportData(windows, file)).toEqual({ payloads: 1 });
    expect(importData(linux, file)).toEqual({ payloadsAdded: 0, payloadsInFile: 1 });

    exportData(linux, file);
    expect(importData(windows, file)).toEqual({ payloadsAdded: 1, payloadsInFile: 2 });
    expect(importData(windows, file)).toEqual({ payloadsAdded: 0, payloadsInFile: 2 });
    expect(performerLedger(windows)[0]).toMatchObject({ pages: 2, reached_end: 1 });
    expect(coBilled(windows)).toContain("Pkew Pkew Pkew");
    windows.close();
    linux.close();
  });

  it("overwrites an earlier export", () => {
    const file = path.join(dir, "out.sqlite");
    exportData(db, file);
    store(db, 1, PAGE_1);
    expect(exportData(db, file)).toEqual({ payloads: 1 });
    expect(importData(openDb(":memory:"), file).payloadsInFile).toBe(1);
  });

  it("refuses files that aren't exports, or are from newer code", () => {
    const other = path.join(dir, "other.sqlite");
    new DatabaseSync(other).close();
    expect(() => importData(db, other)).toThrow("not a bandwagon export");
    expect(() => importData(db, path.join(dir, "missing.sqlite"))).toThrow("no such file");

    const newer = path.join(dir, "newer.sqlite");
    exportData(db, newer);
    const raw = new DatabaseSync(newer);
    raw.exec("UPDATE meta SET value = '99' WHERE key = 'version'");
    raw.close();
    expect(() => importData(db, newer)).toThrow("Update bandwagon first");
  });
});
