import { beforeEach, describe, expect, it, vi } from "vitest";
import { callsThisMonth, recordCalls } from "./budget";
import { openDb, type Db } from "./db";
import type { AreaQuery, JbEvent } from "./jambase";
import { areaPullDue, checkArea, lastAreaPull, pullArea, type FetchAreaPage } from "./metro";
import { DETROIT, nearbyShows } from "./nearby";

const NOW = new Date("2026-10-10T12:00:00Z");
const DET = { latitude: 42.3364, longitude: -83.0499 };
const CLE = { latitude: 41.4993, longitude: -81.6944 };
const CHI = { latitude: 41.8781, longitude: -87.6298 };

let n = 0;
const concert = (geo: { latitude: number; longitude: number } | undefined, acts = ["Alpha", "Bravo"]) =>
  ({
    "@type": "Concert",
    identifier: `jambase:e${++n}`,
    startDate: "2026-11-01T20:00:00",
    location: { name: `Venue ${n}`, address: { addressLocality: "Somewhere" }, geo },
    performer: acts.map((name, i) => ({ identifier: `jambase:${name}`, name, "x-isHeadliner": i === 0 })),
  }) as JbEvent;

/** A fake JamBase serving `pages`, counting every call. */
function fake(pages: JbEvent[][]) {
  const queries: AreaQuery[] = [];
  const fetchPage: FetchAreaPage = async (q, onCall) => {
    onCall();
    queries.push(q);
    return { events: pages[q.page - 1] ?? [], pagination: { page: q.page, totalPages: pages.length } };
  };
  return { fetchPage, queries };
}

let db: Db;
beforeEach(() => {
  db = openDb(":memory:");
  vi.unstubAllEnvs();
});

describe("checkArea", () => {
  it("passes venues within the radius", () => {
    expect(checkArea([concert(DET), concert(CLE)], DETROIT).ok).toBe(true);
  });

  it("fails when venues come back from far away", () => {
    const c = checkArea([concert(DET), concert(CHI)], DETROIT);
    expect(c.ok).toBe(false);
    expect(c.outside).toBe(1);
  });

  it("fails a page with no venue coordinates, passes an empty one", () => {
    expect(checkArea([concert(undefined)], DETROIT).ok).toBe(false);
    expect(checkArea([], DETROIT).ok).toBe(true);
  });
});

describe("pullArea", () => {
  it("stores every page and counts each call", async () => {
    const { fetchPage, queries } = fake([[concert(DET), concert(CLE, ["Solo"])], [concert(DET)]]);
    const r = await pullArea(db, DETROIT, { now: NOW, fetchPage });
    expect(r.pull.outcome).toBe("complete");
    expect(r.calls).toBe(2);
    expect(queries.map((q) => q.page)).toEqual([1, 2]);
    expect(queries[0]).toMatchObject({ lat: DETROIT.lat, radiusMiles: 100, from: "2026-10-10" });
    expect(callsThisMonth(db, "jambase", NOW)).toBe(2);
    expect(r.pull.concerts).toBe(3);
    expect(r.pull.with_others).toBe(2);
    // A band nobody looked up now has its local date.
    const alpha = db.prepare("SELECT id FROM artists WHERE jambase_id = 'jambase:Alpha'").get() as { id: number };
    expect(nearbyShows(db, alpha.id, "2026-10-10", DETROIT)).toHaveLength(1);
    expect(areaPullDue(db, DETROIT, NOW)).toBe(false);
    expect(areaPullDue(db, DETROIT, new Date("2026-11-10T12:00:00Z"))).toBe(true);
  });

  it("stops after one call, storing nothing, when the filter is ignored", async () => {
    const { fetchPage } = fake([[concert(CHI), concert(CHI)], [concert(DET)]]);
    const r = await pullArea(db, DETROIT, { now: NOW, fetchPage });
    expect(r.pull.outcome).toBe("filter-ignored");
    expect(r.calls).toBe(1);
    expect(db.prepare("SELECT COUNT(*) AS n FROM events").get()).toEqual({ n: 0 });
    expect(areaPullDue(db, DETROIT, new Date("2026-10-12T12:00:00Z"))).toBe(false);
    expect(areaPullDue(db, DETROIT, new Date("2026-10-18T12:00:00Z"))).toBe(true);
  });

  it("checks with one page, then resumes where it stopped", async () => {
    const pages = [[concert(DET)], [concert(DET)], [concert(CLE)]];
    const first = await pullArea(db, DETROIT, { now: NOW, maxPages: 1, fetchPage: fake(pages).fetchPage });
    expect(first.check?.ok).toBe(true);
    expect(first.pull).toMatchObject({ outcome: "partial", next_page: 2, total_pages: 3 });

    const { fetchPage, queries } = fake(pages);
    const rest = await pullArea(db, DETROIT, { now: NOW, fetchPage });
    expect(queries.map((q) => q.page)).toEqual([2, 3]);
    expect(rest.pull).toMatchObject({ id: first.pull.id, outcome: "complete", calls: 3, concerts: 3 });
  });

  it("stays inside the area's monthly cap and the overall budget", async () => {
    vi.stubEnv("BANDWAGON_AREA_MONTHLY_CALLS", "2");
    const pages = [[concert(DET)], [concert(DET)], [concert(DET)]];
    const r = await pullArea(db, DETROIT, { now: NOW, fetchPage: fake(pages).fetchPage });
    expect(r).toMatchObject({ calls: 2, stoppedBy: "area-cap" });
    expect(lastAreaPull(db, DETROIT)?.outcome).toBe("partial");

    vi.stubEnv("BANDWAGON_AREA_MONTHLY_CALLS", "100");
    vi.stubEnv("JAMBASE_MONTHLY_BUDGET", "10");
    recordCalls(db, "jambase", 8, NOW);
    const again = await pullArea(db, DETROIT, { now: NOW, fetchPage: fake(pages).fetchPage });
    expect(again).toMatchObject({ calls: 0, stoppedBy: "budget" });
  });

  it("leaves a pull to resume when nothing went out", async () => {
    const fetchPage: FetchAreaPage = async () => {
      throw new Error("JAMBASE_API_KEY is not set");
    };
    await expect(pullArea(db, DETROIT, { now: NOW, fetchPage })).rejects.toThrow();
    expect(lastAreaPull(db, DETROIT)?.outcome).toBe("partial");
    expect(callsThisMonth(db, "jambase", NOW)).toBe(0);
  });
});
