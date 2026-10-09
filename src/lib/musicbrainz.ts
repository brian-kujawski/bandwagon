import { TtlCache } from "./cache.ts";

const BASE = "https://musicbrainz.org/ws/2";
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** An artist candidate as shown in the disambiguation list. */
export type ArtistCandidate = {
  mbid: string;
  name: string;
  disambiguation: string;
  type: string | null;
  country: string | null;
  area: string | null;
  years: string | null;
  tags: string[];
};

/** The parts of a MusicBrainz artist record we read. */
export type MbArtist = {
  id: string;
  name: string;
  disambiguation?: string;
  type?: string | null;
  country?: string | null;
  area?: { name?: string } | null;
  "begin-area"?: { name?: string } | null;
  "life-span"?: { begin?: string | null; end?: string | null; ended?: boolean | null };
  tags?: { name: string; count: number }[];
};

export class MusicBrainzError extends Error {}

function userAgent(): string {
  const contact =
    process.env.MUSICBRAINZ_CONTACT || "https://github.com/brian-kujawski/bandwagon";
  return `bandwagon/0.1 ( ${contact} )`;
}

// MusicBrainz allows one request per second per client. Chain every request
// onto the previous one so concurrent callers queue instead of bursting.
let queue: Promise<unknown> = Promise.resolve();
let lastRequestAt = 0;

function throttled<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(async () => {
    const wait = lastRequestAt + 1000 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastRequestAt = Date.now();
    return fn();
  });
  queue = run.catch(() => undefined);
  return run;
}

async function mbFetch<T>(path: string, params: Record<string, string>): Promise<T> {
  const url = `${BASE}${path}?${new URLSearchParams({ ...params, fmt: "json" })}`;
  return throttled(async () => {
    const res = await fetch(url, {
      headers: { "User-Agent": userAgent(), Accept: "application/json" },
    });
    if (!res.ok) {
      throw new MusicBrainzError(`MusicBrainz returned HTTP ${res.status} for ${path}`);
    }
    return (await res.json()) as T;
  });
}

/** Escape Lucene query syntax so band names like "AC/DC" or "!!!" search literally. */
export function escapeLucene(text: string): string {
  return text.replace(/([+\-!(){}[\]^"~*?:\\/]|&&|\|\|)/g, "\\$1");
}

function years(lifeSpan: MbArtist["life-span"]): string | null {
  const begin = lifeSpan?.begin?.slice(0, 4);
  const end = lifeSpan?.end?.slice(0, 4);
  if (!begin && !end) return null;
  if (begin && end) return `${begin}–${end}`;
  if (begin) return lifeSpan?.ended ? `${begin}–?` : `${begin}–present`;
  return `?–${end}`;
}

export function toCandidate(a: MbArtist): ArtistCandidate {
  const tags = [...(a.tags ?? [])]
    .sort((x, y) => y.count - x.count)
    .slice(0, 3)
    .map((t) => t.name);
  return {
    mbid: a.id,
    name: a.name,
    disambiguation: a.disambiguation ?? "",
    type: a.type ?? null,
    country: a.country ?? null,
    area: a.area?.name ?? a["begin-area"]?.name ?? null,
    years: years(a["life-span"]),
    tags,
  };
}

const searchCache = new TtlCache<ArtistCandidate[]>(WEEK_MS);
const artistCache = new TtlCache<ArtistCandidate | null>(WEEK_MS);

/** Search MusicBrainz for artists matching a typed name, best match first. */
export async function searchArtists(name: string, limit = 10): Promise<ArtistCandidate[]> {
  const q = name.trim();
  if (!q) return [];
  return searchCache.getOrLoad(`${q.toLowerCase()}|${limit}`, async () => {
    const data = await mbFetch<{ artists?: MbArtist[] }>("/artist", {
      query: escapeLucene(q),
      limit: String(limit),
    });
    return (data.artists ?? []).map(toCandidate);
  });
}

const MBID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isMbid(value: string): boolean {
  return MBID.test(value);
}

/** Look up one artist by MusicBrainz ID. Returns null when it does not exist. */
export async function getArtist(mbid: string): Promise<ArtistCandidate | null> {
  if (!isMbid(mbid)) return null;
  return artistCache.getOrLoad(mbid.toLowerCase(), async () => {
    try {
      return toCandidate(await mbFetch<MbArtist>(`/artist/${mbid}`, { inc: "tags" }));
    } catch (e) {
      if (e instanceof MusicBrainzError && e.message.includes("HTTP 404")) return null;
      throw e;
    }
  });
}
