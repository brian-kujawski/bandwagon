/**
 * Upcoming shows within reach of home. Home defaults to downtown Detroit with
 * a 100-mile straight-line radius (decided 2026-10-09), which takes in
 * Cleveland, Lansing, Toledo, Ann Arbor, Flint and Windsor. The Settings
 * page changes it (home.ts); BANDWAGON_HOME="lat,lon" and
 * BANDWAGON_RADIUS_MILES set the default before anything is saved there.
 */
import type { Db } from "./db.ts";

export type Home = { lat: number; lon: number; radiusMiles: number };

export const DETROIT: Home = { lat: 42.3314, lon: -83.0458, radiusMiles: 100 };

export type NearbyShow = {
  date: string;
  /** HH:MM at the venue, when known. */
  time: string | null;
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
      `SELECT e.date, e.start_time, e.venue, e.city, e.url, e.lat, e.lon
       FROM appearances a JOIN events e ON e.id = a.event_id
       WHERE a.artist_id = ? AND e.cancelled = 0 AND e.date >= ?
         AND e.lat BETWEEN ? AND ? AND e.lon IS NOT NULL
       ORDER BY e.date, e.source = 'jambase' DESC`,
    )
    .all(artistId, today, home.lat - dLat, home.lat + dLat) as {
    date: string;
    start_time: string | null;
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
    shows.push({ date: r.date, time: r.start_time, venue: r.venue ?? "", city: r.city ?? "", url: r.url, miles });
  }
  return shows;
}

export type ConcertShow = NearbyShow & {
  eventId: number;
  /** The liked bands on the bill, headliner first. */
  liked: string[];
  /** Suggested bands on the bill, headliner first, with their suggestion score. */
  suggested: { name: string; score: number }[];
  /** Everyone on the bill, headliner first. */
  lineup: string[];
};

/**
 * Every upcoming show near home with at least one liked band, or one of the
 * `suggested` bands (artist id -> score), on the bill, soonest first. A show
 * several of these bands share is listed once. As in nearbyShows, a band
 * counts once per date, so a show stored by two sources isn't listed twice.
 */
export function concertsFor(
  db: Db,
  bands: { liked: number[]; suggested?: Map<number, number> },
  today: string,
  home: Home,
): ConcertShow[] {
  const liked = new Set(bands.liked);
  const suggested = new Map([...(bands.suggested ?? [])].filter(([id]) => !liked.has(id)));
  const ids = [...liked, ...suggested.keys()];
  if (ids.length === 0) return [];
  const dLat = home.radiusMiles / 69;
  const rows = db
    .prepare(
      `SELECT e.id, e.date, e.start_time, e.venue, e.city, e.url, e.lat, e.lon, a.artist_id
       FROM appearances a JOIN events e ON e.id = a.event_id
       WHERE a.artist_id IN (SELECT value FROM json_each(?)) AND e.cancelled = 0 AND e.date >= ?
         AND e.lat BETWEEN ? AND ? AND e.lon IS NOT NULL
       ORDER BY e.date, e.source = 'jambase' DESC, e.id`,
    )
    .all(JSON.stringify(ids), today, home.lat - dLat, home.lat + dLat) as {
    id: number;
    date: string;
    start_time: string | null;
    venue: string | null;
    city: string | null;
    url: string | null;
    lat: number;
    lon: number;
    artist_id: number;
  }[];

  const seen = new Set<string>(); // artist|date
  const kept = new Map<number, (typeof rows)[number] & { miles: number }>();
  for (const r of rows) {
    const key = `${r.artist_id}|${r.date}`;
    if (seen.has(key) && !kept.has(r.id)) continue;
    const miles = milesBetween(home.lat, home.lon, r.lat, r.lon);
    if (miles > home.radiusMiles) continue;
    seen.add(key);
    if (!kept.has(r.id)) kept.set(r.id, { ...r, miles });
  }
  if (kept.size === 0) return [];

  const bills = new Map<number, { id: number; name: string }[]>();
  const billRows = db
    .prepare(
      `SELECT p.event_id, ar.id, ar.name
       FROM appearances p JOIN artists ar ON ar.id = p.artist_id
       WHERE p.event_id IN (SELECT value FROM json_each(?))
       ORDER BY p.event_id, COALESCE(p.headliner, 0) DESC, p.billing_rank IS NULL, p.billing_rank, ar.name`,
    )
    .all(JSON.stringify([...kept.keys()])) as { event_id: number; id: number; name: string }[];
  for (const b of billRows) {
    if (!bills.has(b.event_id)) bills.set(b.event_id, []);
    bills.get(b.event_id)!.push({ id: b.id, name: b.name });
  }

  return [...kept.values()].map((r) => {
    const bill = bills.get(r.id) ?? [];
    return {
      eventId: r.id,
      date: r.date,
      time: r.start_time,
      venue: r.venue ?? "",
      city: r.city ?? "",
      url: r.url,
      miles: r.miles,
      liked: bill.filter((b) => liked.has(b.id)).map((b) => b.name),
      suggested: bill.filter((b) => suggested.has(b.id)).map((b) => ({ name: b.name, score: suggested.get(b.id)! })),
      lineup: bill.map((b) => b.name),
    };
  });
}
