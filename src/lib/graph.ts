/**
 * Recommendations from the co-bill graph in the store: artists are nodes, and
 * each shared concert date adds 1 / (acts on the bill - 1) to the edge between
 * two acts (the `cobills` view in db.ts).
 *
 * Two signals:
 *   - direct: the artist shared a bill with one or more of your bands. Artists
 *     linked to more of your bands rank first, then by summed edge weight.
 *   - one step further: the artist shared a bill with an act that shared a bill
 *     with one of your bands (A plays with B, B plays with C, so try C).
 *
 * Scores for every artist are computed in one pass and stored (`affinity`),
 * so a results page reads one slice of a ranked table. That keeps a page the
 * same cost with 10 liked bands or 10,000; the pass itself is redone only when
 * your bands or the stored shows change. A synthetic 100,000-artist graph
 * with 10,000 liked bands scored in about 5 seconds.
 */
import { createHash } from "node:crypto";
import { mostCommon, relationOf, type Relation } from "./cobills.ts";
import { getArtistRow, transaction, type ArtistRow, type Db } from "./db.ts";

/** A 2-hop path counts for this share of its weight. */
export const HOP_DAMPING = 0.5;

/**
 * "One step further" goes out from at most this many of your strongest direct
 * links. With thousands of liked bands, nearly every act is linked to one of
 * them somehow, and paths through weak links are mostly noise.
 */
export const MAX_BRIDGES = 2000;

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

export type GraphPage = {
  candidates: GraphCandidate[];
  /** How many candidates the whole list has. */
  total: number;
};

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

const AFFINITY_SCHEMA = `
CREATE TABLE IF NOT EXISTS profile_artists (
  artist_id INTEGER PRIMARY KEY,
  role TEXT NOT NULL               -- 'seed' (a band you like) or 'excluded' (not interested)
);
-- The cobill_events view, stored: one row per ordered pair of acts per concert.
CREATE TABLE IF NOT EXISTS pair_events (
  a INTEGER NOT NULL, b INTEGER NOT NULL, event_id INTEGER NOT NULL, date_key TEXT NOT NULL, w REAL NOT NULL
);
-- Summed co-bill weight per ordered pair of acts.
CREATE TABLE IF NOT EXISTS edges (a INTEGER NOT NULL, b INTEGER NOT NULL, w REAL NOT NULL, PRIMARY KEY (a, b));
-- The same, counting only shows none of your bands played: a 2-hop link
-- should come from another date, not from two openers on your band's bill.
CREATE TABLE IF NOT EXISTS edges_free (a INTEGER NOT NULL, b INTEGER NOT NULL, w REAL NOT NULL, PRIMARY KEY (a, b));
CREATE INDEX IF NOT EXISTS edges_b ON edges (b);
CREATE INDEX IF NOT EXISTS edges_free_b ON edges_free (b);
CREATE TABLE IF NOT EXISTS affinity (
  artist_id INTEGER PRIMARY KEY,
  links INTEGER NOT NULL,          -- how many of your bands it shared a bill with
  direct REAL NOT NULL,            -- summed edge weight to your bands
  bridged REAL NOT NULL            -- one-step-further score
);
CREATE INDEX IF NOT EXISTS affinity_direct ON affinity (links DESC, direct DESC);
CREATE INDEX IF NOT EXISTS affinity_bridged ON affinity (bridged DESC);
CREATE TABLE IF NOT EXISTS affinity_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

/** The stored shows' state; when it changes the edge table is redone. */
function showsSignature(db: Db): string {
  const counts = db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM events) AS e, (SELECT MAX(id) FROM events) AS m,
              (SELECT MAX(seen_at) FROM events) AS s, (SELECT COUNT(*) FROM appearances) AS ap,
              (SELECT COUNT(*) FROM artists) AS ar`,
    )
    .get();
  return JSON.stringify(counts);
}

/** What the stored scores were computed from; when it changes they are redone. */
function inputsSignature(shows: string, seedIds: number[], exclude: Iterable<number>): string {
  const ids = (xs: Iterable<number>) => [...new Set(xs)].sort((x, y) => x - y).join(",");
  return createHash("sha256").update(`${ids(seedIds)}|${ids(exclude)}|${shows}`).digest("hex");
}

/**
 * Score every artist against your bands and store the result. Skipped when
 * nothing has changed since the last time.
 *
 * - direct = sum over your bands of w(band, artist)
 * - bridged = HOP_DAMPING * sum over bridges B of direct(B) * w'(B, artist) / partners(B),
 *   where the bridges are your MAX_BRIDGES strongest direct links, w' counts
 *   only shows none of your bands played, and partners(B) is how many acts B
 *   has shared those bills with. Dividing by it means an act
 *   that has played with everyone spreads its credit thin instead of pulling
 *   the whole graph into "one step further".
 */
export function rebuildAffinity(db: Db, seedIds: number[], exclude: Iterable<number> = []): boolean {
  db.exec(AFFINITY_SCHEMA);
  const state = (key: string) =>
    (db.prepare("SELECT value FROM affinity_state WHERE key = ?").get(key) as { value: string } | undefined)?.value;
  const setState = db.prepare(
    "INSERT INTO affinity_state (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
  );
  const shows = showsSignature(db);
  const signature = inputsSignature(shows, seedIds, exclude);
  if (state("inputs") === signature) return false;

  transaction(db, () => {
    // The edge table depends only on the shows, so liking a band doesn't redo it.
    if (state("shows") !== shows) {
      // Bulk loads are quicker with the secondary index built afterwards.
      db.exec(`DROP INDEX IF EXISTS edges_b; DROP INDEX IF EXISTS pair_events_a;
        DELETE FROM edges; DELETE FROM pair_events;
        INSERT INTO pair_events (a, b, event_id, date_key, w)
          SELECT a, b, event_id, COALESCE(date, 'event ' || event_id), weight FROM cobill_events;
        INSERT INTO edges (a, b, w)
          SELECT a, b, SUM(w) FROM (SELECT a, b, MAX(w) AS w FROM pair_events GROUP BY a, b, date_key)
          GROUP BY a, b;
        CREATE INDEX edges_b ON edges (b);
        CREATE INDEX pair_events_a ON pair_events (a);`);
      setState.run("shows", shows);
    }
    db.exec(`DELETE FROM profile_artists; DELETE FROM affinity;
      DROP INDEX IF EXISTS edges_free_b; DELETE FROM edges_free;`);
    const addRole = db.prepare("INSERT OR REPLACE INTO profile_artists (artist_id, role) VALUES (?, ?)");
    for (const id of exclude) addRole.run(id, "excluded");
    for (const id of seedIds) addRole.run(id, "seed");

    db.exec(`
      -- CROSS JOIN keeps SQLite walking from your bands into edges, not the other way.
      INSERT INTO affinity (artist_id, links, direct, bridged)
      SELECT e.b, COUNT(*), SUM(e.w), 0
      FROM profile_artists s CROSS JOIN edges e ON e.a = s.artist_id
      WHERE s.role = 'seed' AND e.b NOT IN (SELECT artist_id FROM profile_artists WHERE role = 'seed')
      GROUP BY e.b;

      CREATE TEMP TABLE IF NOT EXISTS bridges (artist_id INTEGER PRIMARY KEY, direct REAL NOT NULL);
      DELETE FROM temp.bridges;
      INSERT INTO temp.bridges
        SELECT artist_id, direct FROM affinity ORDER BY links DESC, direct DESC LIMIT ${MAX_BRIDGES};

      -- Only edges out of bridges are needed.
      CREATE TEMP TABLE IF NOT EXISTS seed_events (event_id INTEGER PRIMARY KEY);
      DELETE FROM temp.seed_events;
      INSERT OR IGNORE INTO temp.seed_events
        SELECT s.event_id FROM appearances s JOIN profile_artists p ON p.artist_id = s.artist_id AND p.role = 'seed';
      INSERT INTO edges_free (a, b, w)
      SELECT a, b, SUM(w) FROM (
        SELECT pe.a, pe.b, MAX(pe.w) AS w FROM temp.bridges br
        CROSS JOIN pair_events pe ON pe.a = br.artist_id
        WHERE pe.event_id NOT IN (SELECT event_id FROM temp.seed_events)
        GROUP BY pe.a, pe.b, pe.date_key
      ) GROUP BY a, b;
      CREATE INDEX edges_free_b ON edges_free (b);
    `);
    db.prepare(
      `INSERT INTO affinity (artist_id, links, direct, bridged)
       SELECT f.b, 0, 0, ? * SUM(br.direct * f.w / d.partners)
       FROM temp.bridges br
       CROSS JOIN edges_free f ON f.a = br.artist_id
       JOIN (SELECT a, COUNT(*) AS partners FROM edges_free GROUP BY a) d ON d.a = br.artist_id
       WHERE f.b NOT IN (SELECT artist_id FROM profile_artists WHERE role = 'seed')
       GROUP BY f.b
       ON CONFLICT (artist_id) DO UPDATE SET bridged = excluded.bridged`,
    ).run(HOP_DAMPING);
    setState.run("inputs", signature);
  });
  return true;
}

const NOT_EXCLUDED = "artist_id NOT IN (SELECT artist_id FROM profile_artists WHERE role = 'excluded')";

/**
 * One page of a ranked list, from the scores `rebuildAffinity` stored, with
 * the links that explain each candidate. Only the page's candidates get their
 * shows looked up.
 */
export function affinityPage(
  db: Db,
  list: "direct" | "oneStep",
  page: { offset?: number; limit?: number; linksShown?: number } = {},
): GraphPage {
  db.exec(AFFINITY_SCHEMA);
  const { offset = 0, limit = 25, linksShown = 3 } = page;
  const where = list === "direct" ? "links > 0" : "links = 0 AND bridged > 0";
  const order =
    list === "direct" ? "links DESC, direct DESC, ar.name COLLATE NOCASE" : "bridged DESC, ar.name COLLATE NOCASE";
  const total = (
    db.prepare(`SELECT COUNT(*) AS n FROM affinity WHERE ${where} AND ${NOT_EXCLUDED}`).get() as { n: number }
  ).n;
  const rows = db
    .prepare(
      `SELECT af.artist_id, af.direct, af.bridged FROM affinity af JOIN artists ar ON ar.id = af.artist_id
       WHERE ${where} AND ${NOT_EXCLUDED} ORDER BY ${order} LIMIT ? OFFSET ?`,
    )
    .all(limit, offset) as { artist_id: number; direct: number; bridged: number }[];

  const row = (id: number) => getArtistRow(db, id)!;
  const seedLinks = db.prepare(
    `SELECT e.a AS id, e.w FROM edges e JOIN profile_artists s ON s.artist_id = e.a AND s.role = 'seed'
     WHERE e.b = ? ORDER BY e.w DESC`,
  );
  const bridgeLinks = db.prepare(
    `SELECT f.a AS id, a.direct * f.w AS w FROM edges_free f JOIN affinity a ON a.artist_id = f.a AND a.links > 0
     WHERE f.b = ? ORDER BY w DESC LIMIT ?`,
  );

  const candidates = rows.map((r): GraphCandidate => {
    const artist = row(r.artist_id);
    if (list === "direct") {
      const links = seedLinks.all(r.artist_id) as { id: number; w: number }[];
      const direct = links.map((l) => ({ seed: row(l.id), weight: l.w, shows: [] as LinkShow[] }));
      for (const link of direct.slice(0, linksShown)) link.shows = sharedShows(db, link.seed.id, artist.id);
      return { artist, score: r.direct, direct, bridges: [] };
    }
    const bridges = (bridgeLinks.all(r.artist_id, linksShown) as { id: number; w: number }[]).map((b) => {
      const strongest = seedLinks.get(b.id) as { id: number; w: number };
      return { seed: row(strongest.id), bridge: row(b.id), weight: HOP_DAMPING * b.w };
    });
    return { artist, score: r.bridged, direct: [], bridges };
  });
  return { candidates, total };
}

/**
 * Rank artists for a set of seed artists (row ids): the first `limit` of each
 * list. Seeds never bridge or get recommended, since a link through one seed
 * is a direct link to it. Artists in `exclude` (bands you're not interested
 * in) are never recommended but can still bridge: they may be how two bands
 * you like connect.
 */
export function recommendFromGraph(
  db: Db,
  seedIds: number[],
  limit = 25,
  exclude: ReadonlySet<number> = new Set(),
): GraphResult {
  rebuildAffinity(db, seedIds, exclude);
  const page = { limit, linksShown: Number.MAX_SAFE_INTEGER };
  return {
    direct: affinityPage(db, "direct", page).candidates,
    oneStep: affinityPage(db, "oneStep", page).candidates,
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
