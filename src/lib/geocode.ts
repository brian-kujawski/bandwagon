/**
 * Turn a place name into coordinates with OpenStreetMap's Nominatim
 * geocoder (decided 2026-10-12). Free and keyless, under its usage policy
 * (https://operations.osmfoundation.org/policies/nominatim/): at most one
 * request a second, an identifying User-Agent, results cached, and searches
 * sent only when someone submits one, never as they type.
 *
 * Typed coordinates ("42.33, -83.05") never reach Nominatim.
 */
import type { Db } from "./db.ts";

const BASE = "https://nominatim.openstreetmap.org";
const USER_AGENT = "bandwagon/0.1 (personal concert finder; https://github.com/brian-kujawski/bandwagon)";
const MIN_GAP_MS = 1100;
/** Places don't move; a cached answer is good for months. */
const CACHE_MS = 90 * 24 * 60 * 60 * 1000;

export const GEOCODE_SCHEMA = `
CREATE TABLE IF NOT EXISTS geocode_cache (
  query TEXT PRIMARY KEY,          -- 'search:<text>' or 'reverse:<lat>,<lon>'
  body TEXT NOT NULL,
  fetched_at TEXT NOT NULL
);
`;

export type Place = { label: string; lat: number; lon: number };

export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

let lastCall = 0;

async function nominatim(db: Db, key: string, url: string, fetcher: Fetcher, now: Date): Promise<unknown> {
  db.exec(GEOCODE_SCHEMA);
  const hit = db.prepare("SELECT body, fetched_at FROM geocode_cache WHERE query = ?").get(key) as
    | { body: string; fetched_at: string }
    | undefined;
  if (hit && now.getTime() - Date.parse(hit.fetched_at) < CACHE_MS) return JSON.parse(hit.body);

  const wait = lastCall + MIN_GAP_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCall = Date.now();
  const res = await fetcher(url, { headers: { "User-Agent": USER_AGENT, "Accept-Language": "en" } });
  if (!res.ok) throw new Error(`the place search answered ${res.status}`);
  const body = await res.json();
  db.prepare(
    `INSERT INTO geocode_cache (query, body, fetched_at) VALUES (?, ?, ?)
     ON CONFLICT (query) DO UPDATE SET body = excluded.body, fetched_at = excluded.fetched_at`,
  ).run(key, JSON.stringify(body), now.toISOString());
  return body;
}

/** "42.33, -83.05" -> coordinates, or null when the text isn't a lat,lon pair. */
export function parseCoordinates(text: string): { lat: number; lon: number } | null {
  const m = text.trim().match(/^(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)$/);
  if (!m) return null;
  const lat = Number(m[1]);
  const lon = Number(m[2]);
  return Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon } : null;
}

type NominatimPlace = { display_name?: string; name?: string; lat?: string; lon?: string };

/** "Detroit, Wayne County, Michigan, United States" -> "Detroit, Wayne County, Michigan". */
export function shortLabel(display: string): string {
  const parts = display.split(",").map((p) => p.trim()).filter(Boolean);
  return parts.slice(0, 3).join(", ") || display;
}

function toPlace(p: NominatimPlace): Place | null {
  const lat = Number(p.lat);
  const lon = Number(p.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { label: shortLabel(p.display_name ?? p.name ?? `${lat}, ${lon}`), lat, lon };
}

/** Up to five places matching the text, best first. */
export async function searchPlaces(
  db: Db,
  text: string,
  fetcher: Fetcher = fetch,
  now: Date = new Date(),
): Promise<Place[]> {
  const q = text.trim().replace(/\s+/g, " ").slice(0, 200);
  if (!q) return [];
  const coords = parseCoordinates(q);
  if (coords) return [{ label: `${coords.lat}, ${coords.lon}`, ...coords }];
  const url = `${BASE}/search?${new URLSearchParams({ q, format: "jsonv2", limit: "5" })}`;
  const body = await nominatim(db, `search:${q.toLowerCase()}`, url, fetcher, now);
  return Array.isArray(body) ? body.map(toPlace).filter((p): p is Place => p !== null) : [];
}

/** A name for the place at these coordinates, e.g. from the browser's location. */
export async function nameOfPlace(
  db: Db,
  lat: number,
  lon: number,
  fetcher: Fetcher = fetch,
  now: Date = new Date(),
): Promise<string | null> {
  const la = lat.toFixed(3);
  const lo = lon.toFixed(3);
  const url = `${BASE}/reverse?${new URLSearchParams({ lat: la, lon: lo, format: "jsonv2", zoom: "10" })}`;
  const body = (await nominatim(db, `reverse:${la},${lo}`, url, fetcher, now)) as NominatimPlace | null;
  return body && typeof body === "object" && body.display_name ? shortLabel(body.display_name) : null;
}
