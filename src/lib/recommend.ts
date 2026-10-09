import { getDb, lastFetched, upsertArtist, type Db } from "./db";
import { recommendFromGraph, type GraphResult } from "./graph";
import { ingestJamBase, type IngestCounts } from "./ingest";
import { getEventsByJamBaseId, getUpcomingEvents, MissingJamBaseKeyError } from "./jambase";
import type { ArtistCandidate } from "./musicbrainz";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Your own bands are re-checked daily, as before. */
const SEED_REFRESH_MS = DAY_MS;
/** Acts we pull in to widen the web are re-checked monthly (decided 2026-10-09). */
const NEIGHBOUR_REFRESH_MS = 30 * DAY_MS;

/**
 * How many of the top directly linked acts to look up on JamBase so their own
 * co-bills feed the "one step further" list. Each costs one JamBase call per
 * month at most. Set BANDWAGON_EXPAND=0 to turn it off.
 */
function expandCount(): number {
  const n = Number(process.env.BANDWAGON_EXPAND ?? 5);
  return Number.isFinite(n) && n >= 0 ? n : 5;
}

export type SeedStatus =
  /** Fetched from JamBase just now. */
  | { kind: "fetched"; counts: IngestCounts }
  /** Checked recently, so the stored shows were used. */
  | { kind: "stored" }
  /** JamBase has no artist matching this MusicBrainz artist. */
  | { kind: "not-on-jambase" }
  /** JamBase was not asked (no key) or failed; stored shows were used. */
  | { kind: "unavailable"; reason: "no-key" | "error" };

export type SeedReport = {
  artist: ArtistCandidate;
  artistId: number;
  status: SeedStatus;
  /** Co-billed concerts on record for this band, from every source. */
  storedShows: number;
};

export type MixOutcome = { seeds: SeedReport[]; graph: GraphResult; today: string };

const isFresh = (at: string | null, maxAgeMs: number, now: Date) =>
  at !== null && now.getTime() - Date.parse(at) < maxAgeMs;

async function refreshSeed(db: Db, artist: ArtistCandidate, now: Date): Promise<Omit<SeedReport, "storedShows">> {
  let artistId = upsertArtist(db, { name: artist.name, mbid: artist.mbid });
  if (isFresh(lastFetched(db, artistId, "jambase"), SEED_REFRESH_MS, now)) {
    return { artist, artistId, status: { kind: "stored" } };
  }
  try {
    const upcoming = await getUpcomingEvents(artist.mbid, artist.name);
    if (upcoming.path === "not-found") return { artist, artistId, status: { kind: "not-on-jambase" } };
    const result = ingestJamBase(
      db,
      upcoming.events,
      { name: artist.name, mbid: artist.mbid, jambaseId: upcoming.jambaseId },
      now.toISOString(),
    );
    artistId = result.artistId;
    return { artist, artistId, status: { kind: "fetched", counts: result.counts } };
  } catch (e) {
    if (!(e instanceof MissingJamBaseKeyError)) console.error(`[recommend] ${artist.name}:`, e);
    const reason = e instanceof MissingJamBaseKeyError ? "no-key" : "error";
    return { artist, artistId, status: { kind: "unavailable", reason } };
  }
}

/** Pull in the top directly linked acts' own shows, so 2-hop links have data. */
async function widen(db: Db, seedIds: number[], now: Date): Promise<void> {
  const n = expandCount();
  if (n === 0) return;
  for (const c of recommendFromGraph(db, seedIds, n).direct) {
    const id = c.artist.jambase_id;
    if (!id || isFresh(lastFetched(db, c.artist.id, "jambase"), NEIGHBOUR_REFRESH_MS, now)) continue;
    try {
      const events = await getEventsByJamBaseId(id);
      ingestJamBase(db, events, { name: c.artist.name, jambaseId: id }, now.toISOString());
    } catch (e) {
      console.error(`[recommend] widening via ${c.artist.name}:`, e);
      return; // a key or quota problem will hit every call; stop here
    }
  }
}

function storedShows(db: Db, artistId: number): number {
  const row = db
    .prepare("SELECT COUNT(DISTINCT date) AS n FROM cobills WHERE a = ?")
    .get(artistId) as { n: number };
  return row.n;
}

/**
 * Recommendations for several bands at once. Each band's upcoming JamBase
 * shows go into the local store; recommendations then come from everything
 * stored, which includes past co-bills loaded from Concert Archives and the
 * shows of acts looked up for earlier searches.
 */
export async function recommendForMany(
  artists: ArtistCandidate[],
  db: Db = getDb(),
  now: Date = new Date(),
): Promise<MixOutcome> {
  const reports: Omit<SeedReport, "storedShows">[] = [];
  for (const artist of artists) reports.push(await refreshSeed(db, artist, now));
  const seedIds = [...new Set(reports.map((r) => r.artistId))];

  const noKey = reports.some((r) => r.status.kind === "unavailable" && r.status.reason === "no-key");
  if (!noKey) await widen(db, seedIds, now);

  return {
    seeds: reports.map((r) => ({ ...r, storedShows: storedShows(db, r.artistId) })),
    graph: recommendFromGraph(db, seedIds),
    today: now.toISOString().slice(0, 10),
  };
}
