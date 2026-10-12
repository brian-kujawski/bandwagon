/**
 * Where "near you" is: a saved home and radius, set on the Settings page.
 *
 * Saved per profile. bandwagon has one person today, so everything uses the
 * "default" profile, but the key is there so more people can each keep their
 * own home later without a schema change. Before anything is saved, home
 * comes from BANDWAGON_HOME / BANDWAGON_RADIUS_MILES, then downtown Detroit
 * at 100 miles (nearby.ts).
 *
 * The radius is capped at 100 miles (decided 2026-10-12): an area pull grows
 * with the square of the radius, and 100 miles already takes in Cleveland.
 */
import type { Db } from "./db.ts";
import { DETROIT, homeFromEnv, type Home } from "./nearby.ts";

export const DEFAULT_PROFILE = "default";
export const RADIUS_PRESETS = [25, 50, 75, 100] as const;
export const MAX_RADIUS_MILES = 100;

export const HOME_SCHEMA = `
CREATE TABLE IF NOT EXISTS home_settings (
  profile TEXT PRIMARY KEY,
  label TEXT NOT NULL,             -- what the place is called, e.g. "Detroit, Michigan"
  lat REAL NOT NULL,
  lon REAL NOT NULL,
  radius_miles REAL NOT NULL,
  updated_at TEXT NOT NULL
);
`;

export type SavedHome = Home & { label: string; updatedAt: string | null };

export function ensureHome(db: Db): void {
  db.exec(HOME_SCHEMA);
}

/** A short name for a home that has no saved label. */
export function defaultLabel(home: Home): string {
  if (home.lat === DETROIT.lat && home.lon === DETROIT.lon) return "Detroit";
  return `${home.lat.toFixed(3)}, ${home.lon.toFixed(3)}`;
}

/** The profile's saved home, or the env/Detroit default when none is saved. */
export function getHome(
  db: Db,
  profile: string = DEFAULT_PROFILE,
  env: Record<string, string | undefined> = process.env,
): SavedHome {
  ensureHome(db);
  const row = db
    .prepare("SELECT label, lat, lon, radius_miles, updated_at FROM home_settings WHERE profile = ?")
    .get(profile) as { label: string; lat: number; lon: number; radius_miles: number; updated_at: string } | undefined;
  if (row) return { lat: row.lat, lon: row.lon, radiusMiles: row.radius_miles, label: row.label, updatedAt: row.updated_at };
  const home = homeFromEnv(env);
  return { ...home, label: defaultLabel(home), updatedAt: null };
}

export type HomeInput = { label: string; lat: number; lon: number; radiusMiles: number };

/** Check a home from a form or the command line; returns why it won't do, or null. */
export function homeProblem(h: HomeInput): string | null {
  if (!Number.isFinite(h.lat) || Math.abs(h.lat) > 90) return "latitude must be between -90 and 90";
  if (!Number.isFinite(h.lon) || Math.abs(h.lon) > 180) return "longitude must be between -180 and 180";
  if (!Number.isFinite(h.radiusMiles) || h.radiusMiles <= 0 || h.radiusMiles > MAX_RADIUS_MILES) {
    return `radius must be more than 0 and at most ${MAX_RADIUS_MILES} miles`;
  }
  if (!h.label.trim()) return "the place needs a name";
  return null;
}

export function setHome(
  db: Db,
  h: HomeInput,
  profile: string = DEFAULT_PROFILE,
  now: string = new Date().toISOString(),
): SavedHome {
  const problem = homeProblem(h);
  if (problem) throw new Error(problem);
  ensureHome(db);
  const label = h.label.trim().slice(0, 200);
  db.prepare(
    `INSERT INTO home_settings (profile, label, lat, lon, radius_miles, updated_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (profile) DO UPDATE SET
       label = excluded.label, lat = excluded.lat, lon = excluded.lon,
       radius_miles = excluded.radius_miles, updated_at = excluded.updated_at`,
  ).run(profile, label, h.lat, h.lon, h.radiusMiles, now);
  return { lat: h.lat, lon: h.lon, radiusMiles: h.radiusMiles, label, updatedAt: now };
}
