/**
 * bandwagon's own store of who played with whom: artists, events, and the
 * appearances that tie them together. Every source (JamBase upcoming shows,
 * Concert Archives history) lands in the same three tables, so a co-bill
 * found in one source can link up with one found in another.
 *
 * SQLite through Node's built-in `node:sqlite` (Node 22.13+), in a local file
 * that git ignores. JamBase's storage terms are still unchecked, so this file
 * is for local, non-commercial experimenting only.
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { normName } from "./concertArchives.ts";

export type Db = DatabaseSync;

export const DEFAULT_DB_FILE = path.join("data", "bandwagon.db");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS artists (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  norm_name TEXT NOT NULL,
  mbid TEXT UNIQUE,
  jambase_id TEXT UNIQUE,
  ca_slug TEXT UNIQUE,
  url TEXT
);
CREATE INDEX IF NOT EXISTS artists_norm_name ON artists (norm_name);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL,            -- 'jambase' | 'concertarchives'
  source_id TEXT NOT NULL,
  date TEXT,                       -- YYYY-MM-DD
  venue TEXT,
  city TEXT,
  url TEXT,
  lat REAL,                        -- venue coordinates, when the source gives them
  lon REAL,
  cancelled INTEGER NOT NULL DEFAULT 0,
  seen_at TEXT NOT NULL,
  UNIQUE (source, source_id)
);
CREATE INDEX IF NOT EXISTS events_date ON events (date);

CREATE TABLE IF NOT EXISTS appearances (
  event_id INTEGER NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  artist_id INTEGER NOT NULL REFERENCES artists (id),
  headliner INTEGER,               -- 1 or 0, NULL when the source doesn't say
  billing_rank INTEGER,
  PRIMARY KEY (event_id, artist_id)
);
CREATE INDEX IF NOT EXISTS appearances_artist ON appearances (artist_id);

-- When each artist's shows were last pulled from each source.
CREATE TABLE IF NOT EXISTS fetches (
  artist_id INTEGER NOT NULL REFERENCES artists (id),
  source TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (artist_id, source)
);

-- One row per ordered pair of acts per concert they shared.
-- weight = 1 / (acts on the bill - 1), so small bills count for more.
CREATE VIEW IF NOT EXISTS cobill_events AS
SELECT x.artist_id AS a,
       y.artist_id AS b,
       e.id AS event_id,
       e.date AS date,
       1.0 / (n.acts - 1) AS weight
FROM appearances x
JOIN appearances y ON y.event_id = x.event_id AND y.artist_id <> x.artist_id
JOIN events e ON e.id = x.event_id
JOIN (SELECT event_id, COUNT(*) AS acts FROM appearances GROUP BY event_id) n
  ON n.event_id = e.id
WHERE e.cancelled = 0;

-- The same, one row per pair per date, so a show stored from two sources counts once.
CREATE VIEW IF NOT EXISTS cobills AS
SELECT a, b, date, MAX(weight) AS weight
FROM cobill_events
GROUP BY a, b, COALESCE(date, 'event ' || event_id);
`;

export function openDb(file: string = DEFAULT_DB_FILE): Db {
  if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA foreign_keys = ON");
  if (file !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
  db.exec(SCHEMA);
  // Databases from before venue coordinates were stored. JamBase shows pick
  // them up on their next refresh.
  const cols = db.prepare("SELECT name FROM pragma_table_info('events')").all() as { name: string }[];
  if (!cols.some((c) => c.name === "lat")) db.exec("ALTER TABLE events ADD COLUMN lat REAL; ALTER TABLE events ADD COLUMN lon REAL;");
  return db;
}

let shared: Db | null = null;

/** The app's database: `BANDWAGON_DB`, or data/bandwagon.db. Use ":memory:" to keep nothing. */
export function getDb(): Db {
  shared ??= openDb(process.env.BANDWAGON_DB || DEFAULT_DB_FILE);
  return shared;
}

const inTransaction = new WeakSet<Db>();

/** Run fn in a transaction. Nested calls join the outer transaction. */
export function transaction<T>(db: Db, fn: () => T): T {
  if (inTransaction.has(db)) return fn();
  inTransaction.add(db);
  db.exec("BEGIN");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  } finally {
    inTransaction.delete(db);
  }
}

export type ArtistRow = {
  id: number;
  name: string;
  mbid: string | null;
  jambase_id: string | null;
  ca_slug: string | null;
  url: string | null;
};

export type ArtistInput = {
  name: string;
  mbid?: string | null;
  jambaseId?: string | null;
  caSlug?: string | null;
  url?: string | null;
};

const ID_COLUMNS = [
  ["mbid", "mbid"],
  ["jambaseId", "jambase_id"],
  ["caSlug", "ca_slug"],
] as const;

export function getArtistRow(db: Db, id: number): ArtistRow | undefined {
  return db
    .prepare("SELECT id, name, mbid, jambase_id, ca_slug, url FROM artists WHERE id = ?")
    .get(id) as ArtistRow | undefined;
}

/**
 * Find or create the artist row for what a source told us, and return its id.
 *
 * Rows match on any shared ID (MusicBrainz, JamBase, Concert Archives). With no
 * ID match, a row with the same name is reused only when it is the only one
 * and none of its IDs contradict ours; that is how a Concert Archives lineup
 * name finds the JamBase artist. Two rows that turn out to share IDs merge.
 */
export function upsertArtist(db: Db, input: ArtistInput): number {
  const given = ID_COLUMNS.filter(([key]) => input[key]).map(
    ([key, col]) => [col, input[key] as string] as const,
  );

  let matches: ArtistRow[] = [];
  for (const [col, value] of given) {
    const row = db
      .prepare(`SELECT id, name, mbid, jambase_id, ca_slug, url FROM artists WHERE ${col} = ?`)
      .get(value) as ArtistRow | undefined;
    if (row && !matches.some((m) => m.id === row.id)) matches.push(row);
  }

  if (matches.length === 0) {
    const sameName = db
      .prepare("SELECT id, name, mbid, jambase_id, ca_slug, url FROM artists WHERE norm_name = ?")
      .all(normName(input.name)) as ArtistRow[];
    const compatible = sameName.filter((row) =>
      given.every(([col, value]) => row[col] === null || row[col] === value),
    );
    if (compatible.length === 1) matches = compatible;
  }

  if (matches.length === 0) {
    const result = db
      .prepare(
        "INSERT INTO artists (name, norm_name, mbid, jambase_id, ca_slug, url) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        input.name,
        normName(input.name),
        input.mbid ?? null,
        input.jambaseId ?? null,
        input.caSlug ?? null,
        input.url ?? null,
      );
    return Number(result.lastInsertRowid);
  }

  matches.sort((a, b) => a.id - b.id);
  const keep = matches[0];
  for (const drop of matches.slice(1)) mergeArtists(db, keep.id, drop.id);

  for (const [col, value] of given) {
    db.prepare(`UPDATE artists SET ${col} = ? WHERE id = ? AND ${col} IS NULL`).run(value, keep.id);
  }
  if (input.url) db.prepare("UPDATE artists SET url = ? WHERE id = ? AND url IS NULL").run(input.url, keep.id);
  return keep.id;
}

/** Fold one artist row into another: appearances, fetch log and IDs. */
export function mergeArtists(db: Db, keepId: number, dropId: number): void {
  const drop = getArtistRow(db, dropId);
  if (!drop || keepId === dropId) return;
  db.prepare(
    `INSERT OR IGNORE INTO appearances (event_id, artist_id, headliner, billing_rank)
     SELECT event_id, ?, headliner, billing_rank FROM appearances WHERE artist_id = ?`,
  ).run(keepId, dropId);
  db.prepare("DELETE FROM appearances WHERE artist_id = ?").run(dropId);
  db.prepare(
    `INSERT INTO fetches (artist_id, source, fetched_at)
     SELECT ?, source, fetched_at FROM fetches WHERE artist_id = ?
     ON CONFLICT (artist_id, source) DO UPDATE SET fetched_at = MAX(fetched_at, excluded.fetched_at)`,
  ).run(keepId, dropId);
  db.prepare("DELETE FROM fetches WHERE artist_id = ?").run(dropId);
  db.prepare("DELETE FROM artists WHERE id = ?").run(dropId);
  for (const [, col] of ID_COLUMNS) {
    const value = drop[col];
    if (value) db.prepare(`UPDATE artists SET ${col} = ? WHERE id = ? AND ${col} IS NULL`).run(value, keepId);
  }
}

export type EventInput = {
  source: "jambase" | "concertarchives";
  sourceId: string;
  date: string | null;
  venue: string;
  city: string;
  url: string | null;
  /** Venue coordinates, when the source gives them. */
  lat?: number | null;
  lon?: number | null;
  cancelled: boolean;
  acts: { artistId: number; headliner: boolean | null; billingRank: number | null }[];
};

/**
 * Store an event and its bill. The bill is replaced on every save, so an
 * opener added after the first announcement shows up on the next refresh.
 */
export function saveEvent(db: Db, e: EventInput, seenAt: string): number {
  const row = db
    .prepare(
      `INSERT INTO events (source, source_id, date, venue, city, url, lat, lon, cancelled, seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (source, source_id) DO UPDATE SET
         date = excluded.date, venue = excluded.venue, city = excluded.city, url = excluded.url,
         lat = COALESCE(excluded.lat, lat), lon = COALESCE(excluded.lon, lon),
         cancelled = excluded.cancelled, seen_at = excluded.seen_at
       RETURNING id`,
    )
    .get(e.source, e.sourceId, e.date, e.venue, e.city, e.url, e.lat ?? null, e.lon ?? null, e.cancelled ? 1 : 0, seenAt) as {
    id: number;
  };
  db.prepare("DELETE FROM appearances WHERE event_id = ?").run(row.id);
  const insert = db.prepare(
    "INSERT OR IGNORE INTO appearances (event_id, artist_id, headliner, billing_rank) VALUES (?, ?, ?, ?)",
  );
  for (const act of e.acts) {
    insert.run(row.id, act.artistId, act.headliner === null ? null : act.headliner ? 1 : 0, act.billingRank);
  }
  return row.id;
}

export function recordFetch(db: Db, artistId: number, source: string, at: string): void {
  db.prepare(
    `INSERT INTO fetches (artist_id, source, fetched_at) VALUES (?, ?, ?)
     ON CONFLICT (artist_id, source) DO UPDATE SET fetched_at = excluded.fetched_at`,
  ).run(artistId, source, at);
}

export function lastFetched(db: Db, artistId: number, source: string): string | null {
  const row = db
    .prepare("SELECT fetched_at FROM fetches WHERE artist_id = ? AND source = ?")
    .get(artistId, source) as { fetched_at: string } | undefined;
  return row?.fetched_at ?? null;
}
