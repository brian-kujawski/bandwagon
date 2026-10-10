/**
 * Upcoming shows within reach of home. Home defaults to downtown Detroit with
 * a 100-mile straight-line radius (decided 2026-10-09), which takes in
 * Cleveland, Lansing, Toledo, Ann Arbor, Flint and Windsor. Override with
 * BANDWAGON_HOME="lat,lon" and BANDWAGON_RADIUS_MILES.
 */
import type { Db } from "./db.ts";

export type Home = { lat: number; lon: number; radiusMiles: number };

export const DETROIT: Home = { lat: 42.3314, lon: -83.0458, radiusMiles: 100 };

export type NearbyShow = {
  date: string;
  venue: string;
  city: string;
  url: string | null;
  miles: number;
};

export function homeFromEnv(env: Record<string, string | undefined> = process.env): Home {
  const [lat, lon] = (env.BANDWAGON_HOME ?? "").split(",").map((x) => Number(x.trim()));
  const radius = Number(env.BANDWAGON_RADIUS_MILES);
  const valid = Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
  return {
    lat: valid && env.BANDWAGON_HOME ? lat : DETROIT.lat,
    lon: valid && env.BANDWAGON_HOME ? lon : DETROIT.lon,
    radiusMiles: Number.isFinite(radius) && radius > 0 ? radius : DETROIT.radiusMiles,
  };
}

/** Great-circle distance in miles. */
export function milesBetween(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * 3958.8 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * An artist's upcoming shows near home, soonest first, one per date. Only
 * shows with venue coordinates count, which today means JamBase ones.
 */
export function nearbyShows(db: Db, artistId: number, today: string, home: Home): NearbyShow[] {
  // A latitude box first, so most far-off shows never reach the distance check.
  const dLat = home.radiusMiles / 69;
  const rows = db
    .prepare(
      `SELECT e.date, e.venue, e.city, e.url, e.lat, e.lon
       FROM appearances a JOIN events e ON e.id = a.event_id
       WHERE a.artist_id = ? AND e.cancelled = 0 AND e.date >= ?
         AND e.lat BETWEEN ? AND ? AND e.lon IS NOT NULL
       ORDER BY e.date, e.source = 'jambase' DESC`,
    )
    .all(artistId, today, home.lat - dLat, home.lat + dLat) as {
    date: string;
    venue: string | null;
    city: string | null;
    url: string | null;
    lat: number;
    lon: number;
  }[];
  const seen = new Set<string>();
  const shows: NearbyShow[] = [];
  for (const r of rows) {
    const miles = milesBetween(home.lat, home.lon, r.lat, r.lon);
    if (miles > home.radiusMiles || seen.has(r.date)) continue;
    seen.add(r.date);
    shows.push({ date: r.date, venue: r.venue ?? "", city: r.city ?? "", url: r.url, miles });
  }
  return shows;
}
