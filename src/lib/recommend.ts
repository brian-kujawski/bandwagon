import { callsThisMonth, monthlyBudget, recordCalls, remainingCalls } from "./budget";
import { getArtistRow, getDb, lastFetched, recordFetch, transaction, type Db } from "./db";
import { affinityPage, rebuildAffinity, type GraphCandidate } from "./graph";
import { ingestJamBase, type IngestCounts } from "./ingest";
import { getEventsByJamBaseId, getUpcomingEvents, MissingJamBaseKeyError } from "./jambase";
import { homeFromEnv, nearbyShows, type NearbyShow } from "./nearby";
import { artistIdsFor, listPrefs, type BandPref } from "./prefs";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Liked bands and the acts we widen to are re-checked monthly (decided 2026-10-09). */
const REFRESH_MS = 30 * DAY_MS;
/** A lookup by MusicBrainz ID can take three calls: by ID, a name search, then events. */
const MAX_CALLS_PER_LOOKUP = 3;

const envCount = (name: string, fallback: number) => {
  const n = Number(process.env[name] ?? fallback);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

/**
 * How many liked bands are looked up on JamBase per page load, oldest check
 * first. Keeps a page quick however many bands you like; the rest wait for
 * later visits (or, later on, the monthly refresh job).
 */
const refreshPerVisit = () => envCount("BANDWAGON_REFRESH_PER_VISIT", 5);

/**
 * How many of the top directly linked acts to look up on JamBase so their own
 * co-bills feed the one-step-further part of the score. Each costs one JamBase call per
 * month at most. Set BANDWAGON_EXPAND=0 to turn it off.
 */
const expandCount = () => envCount("BANDWAGON_EXPAND", 5);

export type SeedStatus =
  /** Fetched from JamBase just now. */
  | { kind: "fetched"; counts: IngestCounts }
  /** JamBase has no artist matching this band. */
  | { kind: "not-on-jambase" }
  /** JamBase failed; stored shows were used. */
  | { kind: "error" };

export type ProfileCandidate = GraphCandidate & {
  /** The artist's upcoming shows near home (BANDWAGON_HOME, default Detroit). */
  nearby: NearbyShow[];
};

export type ProfileOutcome = {
  /** The requested page of the ranked list. */
  results: { candidates: ProfileCandidate[]; total: number };
  today: string;
  /** How many bands you like. */
  liked: number;
  /** Bands looked up on JamBase during this visit. */
  refreshed: { name: string; status: SeedStatus }[];
  /** Liked bands whose shows are due a JamBase check and didn't get one this visit. */
  waiting: number;
  budget: { used: number; limit: number };
  noKey: boolean;
};

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

const isFresh = (at: string | null, now: Date) =>
  at !== null && now.getTime() - Date.parse(at) < REFRESH_MS;

type Seed = { pref: BandPref; artistId: number; checkedAt: string | null };

async function refreshSeed(db: Db, seed: Seed, now: Date): Promise<SeedStatus> {
  const { pref } = seed;
  const at = now.toISOString();
  let calls = 0;
  const onCall = () => (calls += 1);
  try {
    if (pref.mbid) {
      const upcoming = await getUpcomingEvents(pref.mbid, pref.name, onCall);
      if (upcoming.path === "not-found") {
        recordFetch(db, seed.artistId, "jambase", at); // don't ask again until next month
        return { kind: "not-on-jambase" };
      }
      const { counts } = ingestJamBase(
        db,
        upcoming.events,
        { name: pref.name, mbid: pref.mbid, jambaseId: upcoming.jambaseId ?? pref.jambase_id },
        at,
      );
      return { kind: "fetched", counts };
    }
    const events = await getEventsByJamBaseId(pref.jambase_id!, onCall);
    const { counts } = ingestJamBase(db, events, { name: pref.name, jambaseId: pref.jambase_id }, at);
    return { kind: "fetched", counts };
  } finally {
    recordCalls(db, "jambase", calls, now);
  }
}

/** Pull in the top directly linked acts' own shows, so 2-hop links have data. */
async function widen(db: Db, seedIds: number[], exclude: Set<number>, now: Date): Promise<void> {
  const n = expandCount();
  if (n === 0) return;
  rebuildAffinity(db, seedIds, exclude, isoDay(now));
  for (const c of affinityPage(db, { limit: n, linksShown: 0, linkedOnly: true }).candidates) {
    const id = c.artist.jambase_id;
    if (!id || isFresh(lastFetched(db, c.artist.id, "jambase"), now)) continue;
    if (remainingCalls(db, "jambase", now) < 1) return;
    let calls = 0;
    try {
      const events = await getEventsByJamBaseId(id, () => (calls += 1));
      ingestJamBase(db, events, { name: c.artist.name, jambaseId: id }, now.toISOString());
    } catch (e) {
      console.error(`[recommend] widening via ${c.artist.name}:`, e);
      return; // a key or quota problem will hit every call; stop here
    } finally {
      recordCalls(db, "jambase", calls, now);
    }
  }
}

/**
 * Recommendations from every band you like. A few liked bands whose shows are
 * due a check get looked up on JamBase per visit, within the monthly call
 * budget; everything else comes from what is stored, which includes past
 * co-bills from Concert Archives. Bands you're not interested in are left
 * out of the results.
 */
export type PageRequest = { page?: number; size?: number };

export async function recommendForProfile(
  db: Db = getDb(),
  now: Date = new Date(),
  pages: PageRequest = {},
): Promise<ProfileOutcome> {
  const likedPrefs = listPrefs(db, "liked");
  const { seeds, exclude } = transaction(db, () => {
    const ids = artistIdsFor(db, likedPrefs);
    const seeds: Seed[] = likedPrefs.map((pref, i) => ({
      pref,
      artistId: ids[i],
      checkedAt: lastFetched(db, ids[i], "jambase"),
    }));
    return { seeds, exclude: new Set(artistIdsFor(db, listPrefs(db, "not_interested"))) };
  });
  // Saving one band can merge two artist rows, so drop ids that merged away.
  const seedIds = [...new Set(seeds.map((s) => s.artistId))].filter((id) => getArtistRow(db, id));

  const due = seeds
    .filter((s) => (s.pref.mbid || s.pref.jambase_id) && !isFresh(s.checkedAt, now))
    .sort((a, b) => (a.checkedAt ?? "").localeCompare(b.checkedAt ?? ""));

  const refreshed: ProfileOutcome["refreshed"] = [];
  let noKey = false;
  for (const seed of due.slice(0, refreshPerVisit())) {
    if (remainingCalls(db, "jambase", now) < MAX_CALLS_PER_LOOKUP) break;
    try {
      refreshed.push({ name: seed.pref.name, status: await refreshSeed(db, seed, now) });
    } catch (e) {
      if (e instanceof MissingJamBaseKeyError) {
        noKey = true;
        break;
      }
      console.error(`[recommend] ${seed.pref.name}:`, e);
      refreshed.push({ name: seed.pref.name, status: { kind: "error" } });
    }
  }
  if (!noKey && seedIds.length > 0) await widen(db, seedIds, exclude, now);

  const today = isoDay(now);
  rebuildAffinity(db, seedIds, exclude, today);
  const size = pages.size ?? 25;
  const page = affinityPage(db, { offset: (pages.page ?? 0) * size, limit: size });
  const home = homeFromEnv();
  return {
    results: {
      total: page.total,
      candidates: page.candidates.map((c) => ({ ...c, nearby: nearbyShows(db, c.artist.id, today, home) })),
    },
    today,
    liked: likedPrefs.length,
    refreshed,
    waiting: due.length - refreshed.filter((r) => r.status.kind !== "error").length,
    budget: { used: callsThisMonth(db, "jambase", now), limit: monthlyBudget("jambase") },
    noKey,
  };
}
