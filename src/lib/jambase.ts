import { TtlCache } from "./cache.ts";

const BASE = "https://api.data.jambase.com/v3";
const DAY_MS = 24 * 60 * 60 * 1000;

/** The parts of a JamBase performer we read. */
export type JbPerformer = {
  name: string;
  identifier: string;
  url?: string;
  "x-isHeadliner"?: boolean;
  "x-performanceRank"?: number;
};

/** The parts of a JamBase event we read. */
export type JbEvent = {
  "@type": string; // "Concert" or "Festival"
  name?: string;
  identifier: string;
  url?: string;
  eventStatus?: string;
  startDate?: string;
  location?: {
    name?: string;
    address?: {
      addressLocality?: string;
      addressRegion?: { alternateName?: string; name?: string };
      addressCountry?: { identifier?: string; name?: string };
    };
  };
  performer?: JbPerformer[];
};

export type JbArtist = {
  name: string;
  identifier: string;
  url?: string;
  "x-numUpcomingEvents"?: number;
  sameAs?: { identifier?: string; url?: string }[];
};

/** How we found the artist on JamBase, logged so we can tell whether MBID lookup works. */
export type LookupPath = "musicbrainz-id" | "name-search" | "not-found";

export type UpcomingEvents = {
  path: LookupPath;
  /** The JamBase artist ID, when known. */
  jambaseId: string | null;
  events: JbEvent[];
};

export class JamBaseError extends Error {
  status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

export class MissingJamBaseKeyError extends Error {
  constructor() {
    super("JAMBASE_API_KEY is not set. Copy .env.example to .env.local and add your key.");
  }
}

/** Told about every call that goes out, so callers can count them against the monthly budget. */
export type OnCall = () => void;

async function jbFetch<T>(path: string, params: Record<string, string>, onCall?: OnCall): Promise<T> {
  const key = process.env.JAMBASE_API_KEY;
  if (!key) throw new MissingJamBaseKeyError();
  onCall?.();
  const url = `${BASE}${path}?${new URLSearchParams(params)}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
  });
  if (!res.ok) {
    throw new JamBaseError(`JamBase returned HTTP ${res.status} for ${path}`, res.status);
  }
  return (await res.json()) as T;
}

async function eventsFor(artistId: string, onCall?: OnCall): Promise<JbEvent[]> {
  // perPage 100 covers every band in our test (the busiest had 25 upcoming).
  const data = await jbFetch<{ events?: JbEvent[] }>(
    "/events",
    { artistId, perPage: "100" },
    onCall,
  );
  return data.events ?? [];
}

/** Pick the JamBase artist for a MusicBrainz artist from a name search. */
export function matchArtist(
  artists: JbArtist[],
  mbid: string,
  name: string,
): JbArtist | null {
  const byMbid = artists.find((a) =>
    a.sameAs?.some(
      (s) => s.identifier === "musicbrainz" && s.url?.toLowerCase().endsWith(mbid.toLowerCase()),
    ),
  );
  if (byMbid) return byMbid;
  // Without an MBID link, only trust a single exact name match.
  const exact = artists.filter((a) => a.name.toLowerCase() === name.trim().toLowerCase());
  return exact.length === 1 ? exact[0] : null;
}

const cache = new TtlCache<UpcomingEvents>(DAY_MS);

/**
 * Upcoming events for an artist, looked up by MusicBrainz ID.
 *
 * Tries JamBase's `musicbrainz:<mbid>` artist ID first (one call). JamBase's
 * spec says it accepts these, but that is not yet confirmed live, so when that
 * call fails or comes back empty we search by name and match on the
 * MusicBrainz link JamBase stores for each artist.
 */
export async function getUpcomingEvents(mbid: string, name: string, onCall?: OnCall): Promise<UpcomingEvents> {
  return cache.getOrLoad(mbid.toLowerCase(), async () => {
    let byMbid: JbEvent[] = [];
    try {
      byMbid = await eventsFor(`musicbrainz:${mbid}`, onCall);
    } catch (e) {
      // Only fall through on "not found"-style answers; auth and quota errors are real.
      if (!(e instanceof JamBaseError) || ![400, 404].includes(e.status ?? 0)) throw e;
    }
    if (byMbid.length > 0) {
      console.info(`[jambase] ${name}: found ${byMbid.length} events by MusicBrainz ID`);
      return { path: "musicbrainz-id", jambaseId: null, events: byMbid };
    }

    const found = await jbFetch<{ artists?: JbArtist[] }>(
      "/artists",
      { artistName: name, perPage: "10" },
      onCall,
    );
    const artist = matchArtist(found.artists ?? [], mbid, name);
    if (!artist) {
      console.info(`[jambase] ${name}: no matching JamBase artist`);
      return { path: "not-found", jambaseId: null, events: [] };
    }
    const events =
      artist["x-numUpcomingEvents"] === 0 ? [] : await eventsFor(artist.identifier, onCall);
    console.info(`[jambase] ${name}: found ${events.length} events by name search`);
    return { path: "name-search", jambaseId: artist.identifier, events };
  });
}

const byIdCache = new TtlCache<JbEvent[]>(DAY_MS);

/** Upcoming events for an artist we already know by JamBase ID (one call). */
export async function getEventsByJamBaseId(jambaseId: string, onCall?: OnCall): Promise<JbEvent[]> {
  return byIdCache.getOrLoad(jambaseId, () => eventsFor(jambaseId, onCall));
}
