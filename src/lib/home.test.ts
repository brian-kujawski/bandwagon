import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "./db";
import { getHome, homeProblem, setHome } from "./home";
import { DETROIT } from "./nearby";
import { exportData, importData } from "./portable";

let db: Db;
let dir: string;
beforeEach(() => {
  db = openDb(":memory:");
  dir = mkdtempSync(path.join(tmpdir(), "home-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const CHICAGO = { label: "Chicago, Illinois", lat: 41.8781, lon: -87.6298, radiusMiles: 50 };

describe("getHome", () => {
  it("falls back to the env, then Detroit", () => {
    expect(getHome(db, "default", {})).toMatchObject({ ...DETROIT, label: "Detroit", updatedAt: null });
    expect(getHome(db, "default", { BANDWAGON_HOME: "41.88,-87.63", BANDWAGON_RADIUS_MILES: "40" })).toMatchObject({
      lat: 41.88,
      lon: -87.63,
      radiusMiles: 40,
      label: "41.880, -87.630",
    });
  });

  it("prefers the saved home, per profile", () => {
    setHome(db, CHICAGO, "default", "2026-10-12T00:00:00Z");
    expect(getHome(db, "default", {})).toMatchObject({ ...CHICAGO, updatedAt: "2026-10-12T00:00:00Z" });
    expect(getHome(db, "someone-else", {})).toMatchObject(DETROIT);
  });
});

describe("setHome", () => {
  it("caps the radius at 100 miles and checks coordinates", () => {
    expect(homeProblem({ ...CHICAGO, radiusMiles: 150 })).toMatch(/100/);
    expect(homeProblem({ ...CHICAGO, lat: 95 })).toMatch(/latitude/);
    expect(homeProblem({ ...CHICAGO, label: " " })).toMatch(/name/);
    expect(() => setHome(db, { ...CHICAGO, radiusMiles: 0 })).toThrow();
  });
});

describe("export and import", () => {
  it("carries the saved home, newer change winning", () => {
    setHome(db, CHICAGO, "default", "2026-10-12T00:00:00Z");
    const file = path.join(dir, "out.sqlite");
    exportData(db, file);

    const other = openDb(":memory:");
    importData(other, file);
    expect(getHome(other, "default", {})).toMatchObject(CHICAGO);

    setHome(other, { ...CHICAGO, label: "Evanston", radiusMiles: 25 }, "default", "2026-10-13T00:00:00Z");
    importData(other, file);
    expect(getHome(other, "default", {})).toMatchObject({ label: "Evanston", radiusMiles: 25 });
  });
});
