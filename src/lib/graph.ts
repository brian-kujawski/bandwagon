/**
 * Recommendations from the co-bill graph in the store: artists are nodes, and
 * each shared concert date adds 1 / (acts on the bill - 1) to the edge between
 * two acts (the `cobills` view in db.ts).
 *
 * Two signals for now:
 *   - direct: the artist shared a bill with one or more of your bands. Artists
 *     linked to more of your bands rank first.
 *   - one step further: the artist shared a bill with an act that shared a bill
 *     with one of your bands (A plays with B, B plays with C, so try C).
 */
import { mostCommon, relationOf, type Relation } from "./cobills.ts";
import { getArtistRow, type ArtistRow, type Db } from "./db.ts";

/** A 2-hop path counts for this share of the product of its two edge weights. */
export const HOP_DAMPING = 0.5;

export type LinkShow = {
  date: string | null;
  venue: string;
  city: string;
  url: string | null;
  source: string;
  relation: Relation;
};

export type DirectLink = { seed: ArtistRow; weight: number; shows: LinkShow[] };
export type BridgeLink = { seed: ArtistRow; bridge: ArtistRow; weight: number };

export type GraphCandidate = {
  artist: ArtistRow;
  score: number;
  direct: DirectLink[];
  /** Strongest 2-hop paths first. */
  bridges: BridgeLink[];
};

export type GraphResult = {
  /** Linked to at least one of your bands directly. */
  direct: GraphCandidate[];
  /** Linked only through another act. */
  oneStep: GraphCandidate[];
};

type Edge = { a: number; b: number; weight: number };

/**
 * Summed edges from `ids`, one show per date. With `avoid`, shows that any of
 * those artists played are left out: a 2-hop link should come from another
 * date, not from two openers on your band's own bill.
 */
function edgesFrom(db: Db, ids: number[], avoid: number[] = []): Edge[] {
  if (ids.length === 0) return [];
  const list = (xs: number[]) => xs.map(() => "?").join(", ");
  const skip = avoid.length
    ? `AND NOT EXISTS (SELECT 1 FROM appearances s WHERE s.event_id = c.event_id AND s.artist_id IN (${list(avoid)}))`
    : "";
  return db
    .prepare(
      `SELECT a, b, SUM(weight) AS weight FROM (
         SELECT a, b, MAX(weight) AS weight FROM cobill_events c
         WHERE a IN (${list(ids)}) ${skip}
         GROUP BY a, b, COALESCE(date, 'event ' || event_id)
       ) GROUP BY a, b`,
    )
    .all(...ids, ...avoid) as Edge[];
}

/** Every concert two acts shared, oldest first, one per date. */
export function sharedShows(db: Db, seedId: number, otherId: number): LinkShow[] {
  const rows = db
    .prepare(
      `SELECT e.date, e.venue, e.city, e.url, e.source, s.headliner AS seed_head, o.headliner AS other_head
       FROM appearances s
       JOIN appearances o ON o.event_id = s.event_id
       JOIN events e ON e.id = s.event_id
       WHERE s.artist_id = ? AND o.artist_id = ? AND e.cancelled = 0
       ORDER BY e.date, e.source = 'jambase' DESC`,
    )
    .all(seedId, otherId) as {
    date: string | null;
    venue: string | null;
    city: string | null;
    url: string | null;
    source: string;
    seed_head: number | null;
    other_head: number | null;
  }[];
  const flag = (v: number | null) => (v === null ? null : v === 1);
  const seen = new Set<string>();
  const shows: LinkShow[] = [];
  for (const r of rows) {
    if (r.date && seen.has(r.date)) continue;
    if (r.date) seen.add(r.date);
    shows.push({
      date: r.date,
      venue: r.venue ?? "",
      city: r.city ?? "",
      url: r.url,
      source: r.source,
      relation: relationOf(flag(r.seed_head), flag(r.other_head)),
    });
  }
  return shows;
}

/**
 * Rank artists for a set of seed artists (row ids). Direct links score their
 * edge weight; each 2-hop path seed - bridge - candidate scores
 * HOP_DAMPING * w(seed, bridge) * w(bridge, candidate), counting only the
 * bridge's shows without any of your bands. Seeds never bridge or get
 * recommended, since a link through one seed is a direct link to it.
 * Artists in `exclude` (bands you're not interested in) are never recommended
 * but can still bridge: they may be how two bands you like connect.
 */
export function recommendFromGraph(
  db: Db,
  seedIds: number[],
  limit = 25,
  exclude: ReadonlySet<number> = new Set(),
): GraphResult {
  const seeds = new Set(seedIds);
  const seedRows = new Map(seedIds.map((id) => [id, getArtistRow(db, id)!]));
  const row = memo((id: number) => getArtistRow(db, id)!);
  const candidates = new Map<number, GraphCandidate>();
  const candidate = (id: number) => {
    let c = candidates.get(id);
    if (!c) {
      c = { artist: row(id), score: 0, direct: [], bridges: [] };
      candidates.set(id, c);
    }
    return c;
  };

  const firstHop = edgesFrom(db, seedIds);
  for (const e of firstHop) {
    if (seeds.has(e.b) || exclude.has(e.b)) continue;
    const c = candidate(e.b);
    c.score += e.weight;
    c.direct.push({ seed: seedRows.get(e.a)!, weight: e.weight, shows: [] });
  }

  const bridgeIds = [...new Set(firstHop.map((e) => e.b).filter((id) => !seeds.has(id)))];
  const toBridge = new Map<number, Edge[]>(); // bridge id -> edges from seeds
  for (const e of firstHop) {
    if (!seeds.has(e.b)) toBridge.set(e.b, [...(toBridge.get(e.b) ?? []), e]);
  }
  for (const e of edgesFrom(db, bridgeIds, seedIds)) {
    if (seeds.has(e.b) || exclude.has(e.b)) continue;
    for (const fromSeed of toBridge.get(e.a) ?? []) {
      const weight = HOP_DAMPING * fromSeed.weight * e.weight;
      const c = candidate(e.b);
      c.score += weight;
      c.bridges.push({ seed: seedRows.get(fromSeed.a)!, bridge: row(e.a), weight });
    }
  }

  const all = [...candidates.values()];
  for (const c of all) {
    c.direct.sort((a, b) => b.weight - a.weight);
    c.bridges.sort((a, b) => b.weight - a.weight);
  }
  const byStrength = (a: GraphCandidate, b: GraphCandidate) =>
    reach(b) - reach(a) || b.score - a.score || a.artist.name.localeCompare(b.artist.name);

  const direct = all
    .filter((c) => c.direct.length > 0)
    .sort((a, b) => b.direct.length - a.direct.length || byStrength(a, b))
    .slice(0, limit);
  for (const c of direct) {
    for (const link of c.direct) link.shows = sharedShows(db, link.seed.id, c.artist.id);
  }
  const oneStep = all
    .filter((c) => c.direct.length === 0)
    .sort(byStrength)
    .slice(0, limit);
  return { direct, oneStep };
}

/** How many of your bands a candidate connects to, directly or through a bridge. */
export function reach(c: GraphCandidate): number {
  return new Set([...c.direct.map((d) => d.seed.id), ...c.bridges.map((b) => b.seed.id)]).size;
}

function memo<K, V>(fn: (k: K) => V): (k: K) => V {
  const cache = new Map<K, V>();
  return (k) => {
    if (!cache.has(k)) cache.set(k, fn(k));
    return cache.get(k)!;
  };
}

/** e.g. "Opening for PUP on 6 dates, 4 of them upcoming". */
export function describeDirect(link: DirectLink, today: string): string {
  const seed = link.seed.name;
  const shows = link.shows;
  const upcoming = shows.filter((s) => s.date !== null && s.date >= today).length;
  const past = shows.length - upcoming;
  const dates = (n: number) => (n === 1 ? "1 date" : `${n} dates`);
  const when =
    upcoming && past
      ? `${dates(shows.length)}, ${upcoming} of them upcoming`
      : upcoming
        ? `${upcoming} upcoming ${upcoming === 1 ? "date" : "dates"}`
        : `${past} past ${past === 1 ? "date" : "dates"}`;
  switch (mostCommon(shows.map((s) => s.relation))) {
    case "supports-seed":
      return `Opening for ${seed} on ${when}`;
    case "headlines-over-seed":
      return `${seed} opens for them on ${when}`;
    default:
      return `Sharing the bill with ${seed} on ${when}`;
  }
}

/** e.g. "Plays with NoBro, who plays with PUP". */
export function describeBridge(link: BridgeLink): string {
  return `Shares bills with ${link.bridge.name}, who plays with ${link.seed.name}`;
}
