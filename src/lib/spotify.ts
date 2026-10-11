/**
 * Spotify artist links for suggested bands, so a name on a card opens the
 * band's Spotify page and you can start listening straight away.
 *
 * Uses the client credentials flow (SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET,
 * server side only): an app token, no user sign-in. Artists are found by name
 * search: the first result with the band's exact name wins (Spotify lists the
 * most relevant first). With none, the name links to Spotify's search page for
 * it instead. Each answer is stored in `spotify_matches`, keyed by normalized
 * name, so a band is looked up once (misses are retried after a month).
 */
import { normName } from "./concertArchives.ts";
import type { Db } from "./db.ts";

const TOKEN_URL = "https://accounts.spotify.com/api/token";
const SEARCH_URL = "https://api.spotify.com/v1/search";
const RETRY_MISS_MS = 30 * 24 * 60 * 60 * 1000;
const TIMEOUT_MS = 4000;
/** Lookups at once; a results page needs at most 25. */
const CONCURRENCY = 5;

export const SPOTIFY_SCHEMA = `
-- Misses stored under the first, stricter matching rule; look them up again.
DROP TABLE IF EXISTS spotify_links;
CREATE TABLE IF NOT EXISTS spotify_matches (
  norm_name TEXT PRIMARY KEY,
  spotify_id TEXT,                 -- NULL: no confident match
  checked_at TEXT NOT NULL
);
`;

/** The parts of a Spotify artist we read. */
export type SpArtist = { id: string; name: string };

export class SpotifyError extends Error {
  status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

export const spotifyArtistUrl = (id: string) => `https://open.spotify.com/artist/${id}`;
export const spotifySearchUrl = (name: string) => `https://open.spotify.com/search/${encodeURIComponent(name)}`;

/** Name as compared with Spotify's: case, accents, "&", and a leading "The" don't count. */
export const spotifyKey = (name: string) =>
  normName(name.normalize("NFKD").replace(/\p{M}/gu, "")).replace(/^the /, "");

/** The first search result with the band's name, or null when none has it. */
export function matchSpotifyArtist(results: SpArtist[], name: string): SpArtist | null {
  const key = spotifyKey(name);
  return results.find((a) => spotifyKey(a.name) === key) ?? null;
}

export function hasSpotifyCredentials(): boolean {
  return Boolean(process.env.SPOTIFY_CLIENT_ID && process.env.SPOTIFY_CLIENT_SECRET);
}

/** Spotify's own words on a failed request, e.g. "invalid_client" or "Invalid limit". */
async function failure(what: string, res: Response): Promise<SpotifyError> {
  let detail = "";
  try {
    const body = (await res.json()) as { error?: string | { message?: string }; error_description?: string };
    detail = body.error_description ?? (typeof body.error === "string" ? body.error : (body.error?.message ?? ""));
  } catch {
    // not JSON
  }
  return new SpotifyError(`Spotify ${what} returned HTTP ${res.status}${detail ? ` (${detail})` : ""}`, res.status);
}

let token: { value: string; expiresAt: number } | null = null;
let pending: Promise<string> | null = null;

/** Forget the cached app token (tests). */
export function resetSpotifyToken(): void {
  token = null;
  pending = null;
}

/** The app token, shared by concurrent lookups and renewed a minute before it expires. */
function appToken(): Promise<string> {
  if (token && token.expiresAt > Date.now()) return Promise.resolve(token.value);
  pending ??= requestToken().finally(() => {
    pending = null;
  });
  return pending;
}

async function requestToken(): Promise<string> {
  const id = process.env.SPOTIFY_CLIENT_ID;
  const secret = process.env.SPOTIFY_CLIENT_SECRET;
  if (!id || !secret) throw new SpotifyError("SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET are not set");
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw await failure("token request", res);
  const body = (await res.json()) as { access_token: string; expires_in: number };
  token = { value: body.access_token, expiresAt: Date.now() + (body.expires_in - 60) * 1000 };
  return token.value;
}

/** Search Spotify for artists by name. */
export async function searchSpotifyArtists(name: string): Promise<SpArtist[]> {
  const url = `${SEARCH_URL}?${new URLSearchParams({ q: name, type: "artist", limit: "10" })}`;
  const get = async () =>
    fetch(url, {
      headers: { Authorization: `Bearer ${await appToken()}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  let res = await get();
  if (res.status === 401) {
    // Token revoked or expired early: get a new one and try once more.
    resetSpotifyToken();
    res = await get();
  }
  if (!res.ok) throw await failure("search", res);
  const body = (await res.json()) as { artists?: { items?: (SpArtist | null)[] } };
  return (body.artists?.items ?? []).filter((a): a is SpArtist => Boolean(a?.id && a.name));
}

/** An error's message, with the network cause when fetch only says "fetch failed". */
export function describeError(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  const cause = e.cause instanceof Error ? e.cause.message : "";
  return cause ? `couldn't reach Spotify (${cause})` : e.message;
}

export type SpotifyLinks = {
  /** Name -> artist page, or Spotify's search page for the name. */
  links: Map<string, string>;
  /** Why some names couldn't be looked up this time, for the page to say. */
  problem: string | null;
};

/**
 * The Spotify link for each name: the artist page when one is known or found,
 * otherwise Spotify's search page for the name. Unknown names are looked up
 * (when credentials are set) and the answer stored. A failed lookup stores
 * nothing, so the next visit tries again.
 */
export async function spotifyLinks(db: Db, names: string[], now: Date = new Date()): Promise<SpotifyLinks> {
  db.exec(SPOTIFY_SCHEMA);
  const read = db.prepare("SELECT spotify_id, checked_at FROM spotify_matches WHERE norm_name = ?");
  const links = new Map<string, string>();
  const due: string[] = [];
  for (const name of new Set(names)) {
    const row = read.get(spotifyKey(name)) as { spotify_id: string | null; checked_at: string } | undefined;
    if (row?.spotify_id) links.set(name, spotifyArtistUrl(row.spotify_id));
    else {
      links.set(name, spotifySearchUrl(name));
      if (!row || now.getTime() - Date.parse(row.checked_at) > RETRY_MISS_MS) due.push(name);
    }
  }
  if (due.length === 0) return { links, problem: null };
  if (!hasSpotifyCredentials()) {
    return { links, problem: "SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET aren't set" };
  }

  const save = db.prepare(
    `INSERT INTO spotify_matches (norm_name, spotify_id, checked_at) VALUES (?, ?, ?)
     ON CONFLICT (norm_name) DO UPDATE SET spotify_id = excluded.spotify_id, checked_at = excluded.checked_at`,
  );
  let next = 0;
  let problem: string | null = null;
  const worker = async () => {
    while (next < due.length) {
      const name = due[next++];
      try {
        const match = matchSpotifyArtist(await searchSpotifyArtists(name), name);
        save.run(spotifyKey(name), match?.id ?? null, now.toISOString());
        if (match) links.set(name, spotifyArtistUrl(match.id));
      } catch (e) {
        problem = describeError(e);
        console.error(`[spotify] lookup failed for ${name}: ${problem}`);
        // Bad credentials, a rate limit or no network will fail the rest too; leave them for the next visit.
        next = due.length;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, due.length) }, worker));
  return { links, problem };
}
