import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "./db";
import { ingestJamBase } from "./ingest";
import type { JbEvent } from "./jambase";
import { DETROIT, homeFromEnv, milesBetween, nearbyShows } from "./nearby";

const TODAY = "2026-10-10";
let n = 0;
const show = (date: string, city: string, geo?: { latitude: number; longitude: number }, extra: Partial<JbEvent> = {}) =>
  ({
    "@type": "Concert",
    identifier: `jambase:e${++n}`,
    url: `https://www.jambase.com/show/${n}`,
    startDate: `${date}T20:00:00`,
    location: { name: `Venue ${n}`, address: { addressLocality: city }, geo },
    performer: [
      { identifier: "jambase:1", name: "Alpha", "x-isHeadliner": true },
      { identifier: "jambase:2", name: "Bravo" },
    ],
    ...extra,
  }) as JbEvent;

const DET = { latitude: 42.3364, longitude: -83.0499 };
const CLE = { latitude: 41.4993, longitude: -81.6944 };
const CHI = { latitude: 41.8781, longitude: -87.6298 };

let db: Db;
beforeEach(() => {
  db = openDb(":memory:");
});

describe("milesBetween", () => {
  it("measures straight-line miles", () => {
    expect(milesBetween(DETROIT.lat, DETROIT.lon, CLE.latitude, CLE.longitude)).toBeCloseTo(90, -1);
    expect(milesBetween(DETROIT.lat, DETROIT.lon, CHI.latitude, CHI.longitude)).toBeGreaterThan(200);
  });
});

describe("homeFromEnv", () => {
  it("defaults to Detroit, 100 miles", () => {
    expect(homeFromEnv({})).toEqual(DETROIT);
    expect(homeFromEnv({ BANDWAGON_HOME: "nonsense", BANDWAGON_RADIUS_MILES: "-3" })).toEqual(DETROIT);
  });
  it("reads an override", () => {
    expect(homeFromEnv({ BANDWAGON_HOME: "41.88, -87.63", BANDWAGON_RADIUS_MILES: "50" })).toEqual({
      lat: 41.88,
      lon: -87.63,
      radiusMiles: 50,
    });
  });
});

describe("nearbyShows", () => {
  it("lists upcoming shows within the radius, soonest first", () => {
    const { artistId } = ingestJamBase(
      db,
      [
        show("2026-12-01", "Cleveland", CLE),
        show("2026-11-01", "Detroit", DET),
        show("2026-11-05", "Chicago", CHI),
        show("2026-05-01", "Detroit", DET), // past
        show("2026-11-09", "Detroit"), // no coordinates
        show("2026-11-12", "Detroit", DET, { eventStatus: "cancelled" }),
      ],
      { name: "Alpha" },
    );
    const shows = nearbyShows(db, artistId, TODAY, DETROIT);
    expect(shows.map((s) => s.city)).toEqual(["Detroit", "Cleveland"]);
    expect(shows[0]).toMatchObject({ date: "2026-11-01", venue: "Venue 2", url: "https://www.jambase.com/show/2" });
    expect(shows[0].miles).toBeLessThan(1);
    expect(nearbyShows(db, artistId, TODAY, { ...DETROIT, radiusMiles: 50 }).map((s) => s.city)).toEqual(["Detroit"]);
  });

  it("keeps coordinates when a later save lacks them", () => {
    const e = show("2026-11-01", "Detroit", DET);
    const { artistId } = ingestJamBase(db, [e], { name: "Alpha" });
    ingestJamBase(db, [{ ...e, location: { ...e.location, geo: undefined } }], { name: "Alpha" });
    expect(nearbyShows(db, artistId, TODAY, DETROIT)).toHaveLength(1);
  });
});

describe("openDb", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("adds coordinate columns to an older database", () => {
    dir = mkdtempSync(path.join(tmpdir(), "bandwagon-"));
    const file = path.join(dir, "old.db");
    const old = new DatabaseSync(file);
    old.exec(`CREATE TABLE events (id INTEGER PRIMARY KEY, source TEXT NOT NULL, source_id TEXT NOT NULL,
      date TEXT, venue TEXT, city TEXT, url TEXT, cancelled INTEGER NOT NULL DEFAULT 0, seen_at TEXT NOT NULL,
      UNIQUE (source, source_id))`);
    old.close();
    const db = openDb(file);
    const { artistId } = ingestJamBase(db, [show("2026-11-01", "Detroit", DET)], { name: "Alpha" });
    expect(nearbyShows(db, artistId, TODAY, DETROIT)).toHaveLength(1);
    db.close();
  });
});
