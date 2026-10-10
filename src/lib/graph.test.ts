import { beforeEach, describe, expect, it } from "vitest";
import type { CaSummary } from "./concertArchives";
import { getArtistRow, openDb, upsertArtist, type Db } from "./db";
import { describeBridge, describeDirect, HOP_DAMPING, recommendFromGraph as recommend, UPCOMING_BOOST } from "./graph";
import { ingestConcertArchives, ingestJamBase } from "./ingest";
import type { JbEvent, JbPerformer } from "./jambase";

const act = (id: string, name: string, headliner = false): JbPerformer => ({
  identifier: `jambase:${id}`,
  name,
  "x-isHeadliner": headliner,
});

let n = 0;
const concert = (date: string, performer: JbPerformer[], extra: Partial<JbEvent> = {}): JbEvent => ({
  "@type": "Concert",
  identifier: `jambase:e${++n}`,
  startDate: `${date}T20:00:00`,
  location: { name: "Venue", address: { addressLocality: "Chicago", addressRegion: { alternateName: "IL" } } },
  performer,
  ...extra,
});

const A = act("1", "Alpha", true);
const B = act("2", "Bravo");
const C = act("3", "Charlie");
const D = act("4", "Delta");
const X = act("9", "X-Ray", true);

let db: Db;
beforeEach(() => {
  db = openDb(":memory:");
});

const names = (cs: { artist: { name: string } }[]) => cs.map((c) => c.artist.name);

const TODAY = "2026-10-09";
const recommendFromGraph = (db: Db, seeds: number[]) => recommend(db, seeds, 25, new Set(), TODAY);
/** What one link of summed weight w counts for. */
const s = (w: number) => 1 - Math.exp(-w);
const UP = UPCOMING_BOOST;

describe("ingestJamBase", () => {
  it("stores concerts, skips festivals, and weights by bill size", () => {
    const { artistId, counts } = ingestJamBase(
      db,
      [
        concert("2026-11-01", [A, B]),
        concert("2026-11-02", [A, B]),
        concert("2026-11-03", [A, C, D, X]),
        { ...concert("2026-11-04", [A, D]), "@type": "Festival" },
      ],
      { name: "Alpha", mbid: "mbid-a" },
    );
    expect(counts).toEqual({ concerts: 3, festivalsSkipped: 1, withOthers: 3 });
    expect(getArtistRow(db, artistId)).toMatchObject({ mbid: "mbid-a", jambase_id: "jambase:1" });

    const direct = recommendFromGraph(db, [artistId]);
    expect(names(direct)).toEqual(["Bravo", "Charlie", "Delta", "X-Ray"]);
    expect(direct[0].score).toBeCloseTo(s(2 * UP));
    expect(direct[1].score).toBeCloseTo(s(UP / 3));
    expect(describeDirect(direct[0].direct[0], "2026-10-09")).toBe("Opening for Alpha on 2 upcoming dates");
  });

  it("replaces a bill when an opener is added later", () => {
    const show = concert("2026-11-01", [A]);
    const { artistId } = ingestJamBase(db, [show], { name: "Alpha" });
    expect(recommendFromGraph(db, [artistId])).toEqual([]);
    ingestJamBase(db, [{ ...show, performer: [A, B] }], { name: "Alpha" });
    expect(names(recommendFromGraph(db, [artistId]))).toEqual(["Bravo"]);
  });

  it("drops cancelled shows from the graph", () => {
    const { artistId } = ingestJamBase(db, [concert("2026-11-01", [A, B], { eventStatus: "cancelled" })], {
      name: "Alpha",
    });
    expect(recommendFromGraph(db, [artistId])).toEqual([]);
  });
});

describe("recommendFromGraph", () => {
  it("ranks an act linked to more of your bands first", () => {
    // B tours with A many times; D plays once with each of A and X.
    const a = ingestJamBase(
      db,
      [concert("2026-11-01", [A, B]), concert("2026-11-02", [A, B]), concert("2026-11-03", [A, D])],
      { name: "Alpha" },
    ).artistId;
    const x = ingestJamBase(db, [concert("2026-12-01", [X, D])], { name: "X-Ray" }).artistId;

    const direct = recommendFromGraph(db, [a, x]);
    expect(names(direct)).toEqual(["Delta", "Bravo"]);
    expect(direct[0].direct.map((d) => d.seed.name).sort()).toEqual(["Alpha", "X-Ray"]);
  });

  it("finds acts one step further out through a shared act", () => {
    // A plays with B next month; B plays with C on another date.
    const a = ingestJamBase(db, [concert("2026-11-01", [A, B])], { name: "Alpha" }).artistId;
    ingestJamBase(db, [concert("2026-11-05", [{ ...B, "x-isHeadliner": true }, C])], {
      name: "Bravo",
      jambaseId: "jambase:2",
    });

    const ranked = recommendFromGraph(db, [a]);
    expect(names(ranked)).toEqual(["Bravo", "Charlie"]);
    expect(ranked[1].score).toBeCloseTo(HOP_DAMPING * s(UP) * s(UP));
    expect(ranked[1].bridged).toBe(ranked[1].score);
    expect(ranked[1].direct).toEqual([]);
    expect(describeBridge(ranked[1].bridges[0])).toBe("Shares bills with Bravo, who plays with Alpha");
  });

  it("spreads a busy act's credit thin one step out", () => {
    // Alpha plays with Bravo and with Hub. Bravo plays with Charlie only; Hub plays with Delta and 9 others.
    const H = act("50", "Hub");
    const a = ingestJamBase(db, [concert("2026-11-01", [A, B]), concert("2026-11-02", [A, H])], { name: "Alpha" }).artistId;
    ingestJamBase(db, [concert("2026-11-05", [B, C])], { name: "Bravo", jambaseId: "jambase:2" });
    ingestJamBase(
      db,
      [D, ...Array.from({ length: 9 }, (_, i) => act(`6${i}`, `Other ${i}`))].map((x, i) =>
        concert(`2026-12-${String(i + 1).padStart(2, "0")}`, [H, x]),
      ),
      { name: "Hub", jambaseId: "jambase:50" },
    );
    const oneStep = recommendFromGraph(db, [a]).filter((c) => c.direct.length === 0);
    expect(oneStep[0].artist.name).toBe("Charlie");
    expect(oneStep[0].score).toBeCloseTo(HOP_DAMPING * s(UP) * s(UP));
    expect(oneStep.find((c) => c.artist.name === "Delta")?.score).toBeCloseTo(
      (HOP_DAMPING * s(UP) * s(UP)) / Math.sqrt(10),
    );
  });

  it("counts upcoming dates a little more than past ones", () => {
    const a = ingestJamBase(db, [concert("2026-11-01", [A, B]), concert("2025-11-01", [A, C])], {
      name: "Alpha",
    }).artistId;
    const ranked = recommendFromGraph(db, [a]);
    expect(names(ranked)).toEqual(["Bravo", "Charlie"]);
    expect(ranked[0].score).toBeCloseTo(s(UP));
    expect(ranked[1].score).toBeCloseTo(s(1));
  });

  it("ranks an act two steps from all your bands above one big bill with one of them", () => {
    // Wide plays with a tourmate of each of your four bands. Big shares one ten-act bill with Alpha.
    const seeds = [A, X, act("11", "Yankee", true), act("12", "Zulu", true)];
    const W = act("20", "Wide");
    const big = act("21", "Big");
    const filler = Array.from({ length: 7 }, (_, i) => act(`3${i}`, `Filler ${i}`));
    const ids = seeds.map((seed, i) => {
      const mate = act(`4${i}`, `Mate ${i}`);
      const shows = [concert(`2026-11-0${i + 1}`, [seed, mate])];
      if (i === 0) shows.push(concert("2026-11-20", [seed, big, ...filler]));
      const id = ingestJamBase(db, shows, { name: seed.name }).artistId;
      ingestJamBase(db, [concert(`2026-12-0${i + 1}`, [{ ...mate, "x-isHeadliner": true }, W])], {
        name: mate.name,
        jambaseId: mate.identifier,
      });
      return id;
    });
    const ranked = names(recommendFromGraph(db, ids));
    expect(ranked[0]).toBe("Wide");
    expect(ranked.indexOf("Mate 0")).toBeLessThan(ranked.indexOf("Big"));
  });

  it("redoes scores stored before the combined score", () => {
    db.exec(`CREATE TABLE affinity (artist_id INTEGER PRIMARY KEY, links INTEGER NOT NULL,
      direct REAL NOT NULL, bridged REAL NOT NULL);
      CREATE TABLE affinity_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    const a = ingestJamBase(db, [concert("2026-11-01", [A, B])], { name: "Alpha" }).artistId;
    expect(names(recommendFromGraph(db, [a]))).toEqual(["Bravo"]);
  });

  it("never recommends or bridges through your own bands", () => {
    const a = ingestJamBase(db, [concert("2026-11-01", [A, X])], { name: "Alpha" }).artistId;
    const x = ingestJamBase(db, [concert("2026-11-02", [X, B])], { name: "X-Ray" }).artistId;
    const ranked = recommendFromGraph(db, [a, x]);
    expect(names(ranked)).toEqual(["Bravo"]);
    expect(ranked[0].bridges).toEqual([]);
  });
});

describe("ingestConcertArchives", () => {
  const summary: CaSummary = {
    seed: "Alpha",
    rows: 3,
    duplicates: 0,
    festivalsSkipped: 1,
    noLineup: 0,
    coBills: [],
    shows: [
      { slug: "s1", date: "2025-03-01", venue: "Old Room", title: "Alpha / Bravo", lineup: ["Alpha", "Bravo"], festival: false },
      { slug: "s2", date: "2026-11-01", venue: "Venue", title: "Alpha / Bravo", lineup: ["Alpha", "Bravo"], festival: false },
      { slug: "s3", date: "2025-06-01", venue: "Field", title: "Alpha / Charlie", lineup: ["Alpha", "Charlie"], festival: true },
    ],
  };

  it("links history to JamBase artists by name and counts a show once across sources", () => {
    const a = ingestJamBase(db, [concert("2026-11-01", [A, B])], { name: "Alpha", mbid: "mbid-a" }).artistId;
    const { artistId, shows } = ingestConcertArchives(db, summary, "alpha--1");
    expect(artistId).toBe(a);
    expect(shows).toBe(2);

    const direct = recommendFromGraph(db, [a]);
    expect(names(direct)).toEqual(["Bravo"]);
    // 2025-03-01 from history, 2026-11-01 (upcoming) from both sources
    expect(direct[0].score).toBeCloseTo(s(1 + UP));
    expect(direct[0].direct[0].shows.map((s) => s.source)).toEqual(["concertarchives", "jambase"]);
    expect(describeDirect(direct[0].direct[0], "2026-10-09")).toBe(
      "Opening for Alpha on 2 dates, 1 of them upcoming",
    );
  });
});

describe("upsertArtist", () => {
  it("merges rows that turn out to be the same artist", () => {
    const byName = upsertArtist(db, { name: "Bravo", jambaseId: "jambase:2" });
    const byMbid = upsertArtist(db, { name: "Bravo", mbid: "mbid-b", caSlug: "bravo--1" });
    expect(byMbid).toBe(byName); // unique name, no conflicting IDs

    const other = upsertArtist(db, { name: "Bravo", jambaseId: "jambase:22" });
    expect(other).not.toBe(byName); // same name, different JamBase artist
  });
});
