/**
 * The bands you like, and the ones you've said you're not interested in.
 *
 * There is no cap on either. Rows are keyed by MusicBrainz ID when we have
 * one, because local row ids differ between machines and MBIDs don't; bands
 * found only through JamBase or Concert Archives are keyed by name until an
 * MBID turns up. Removing a band leaves a 'cleared' row rather than deleting
 * it, so the removal survives a merge with an export from another machine
 * (portable.ts: the newer change wins).
 */
import { normName } from "./concertArchives.ts";
import { upsertArtist, type Db } from "./db.ts";

export type PrefStatus = "liked" | "not_interested" | "cleared";

export const PREFS_SCHEMA = `
CREATE TABLE IF NOT EXISTS band_prefs (
  key TEXT PRIMARY KEY,            -- 'mbid:<mbid>' or 'name:<normalised name>'
  name TEXT NOT NULL,
  mbid TEXT,
  jambase_id TEXT,
  ca_slug TEXT,
  status TEXT NOT NULL CHECK (status IN ('liked', 'not_interested', 'cleared')),
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS band_prefs_status ON band_prefs (status, name);
`;

export type BandRef = {
  name: string;
  mbid?: string | null;
  jambaseId?: string | null;
  caSlug?: string | null;
};

export type BandPref = {
  key: string;
  name: string;
  mbid: string | null;
  jambase_id: string | null;
  ca_slug: string | null;
  status: PrefStatus;
  updated_at: string;
};

export function ensurePrefs(db: Db): void {
  db.exec(PREFS_SCHEMA);
}

export const prefKey = (band: BandRef) =>
  band.mbid ? `mbid:${band.mbid.toLowerCase()}` : `name:${normName(band.name)}`;

export function setPref(db: Db, band: BandRef, status: PrefStatus, now: string = new Date().toISOString()): void {
  ensurePrefs(db);
  const name = band.name.trim();
  if (!name) throw new Error("a band needs a name");
  const key = prefKey(band);
  db.prepare(
    `INSERT INTO band_prefs (key, name, mbid, jambase_id, ca_slug, status, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET
       name = excluded.name,
       mbid = COALESCE(excluded.mbid, mbid),
       jambase_id = COALESCE(excluded.jambase_id, jambase_id),
       ca_slug = COALESCE(excluded.ca_slug, ca_slug),
       status = excluded.status,
       updated_at = excluded.updated_at`,
  ).run(key, name, band.mbid?.toLowerCase() ?? null, band.jambaseId ?? null, band.caSlug ?? null, status, now);
  // The same band saved earlier by name only is now covered by its MBID row.
  if (band.mbid) {
    db.prepare(
      "UPDATE band_prefs SET status = 'cleared', updated_at = ? WHERE key = ? AND status <> 'cleared'",
    ).run(now, `name:${normName(name)}`);
  }
}

/** A saved band by its key, whatever its status. */
export function getPrefByKey(db: Db, key: string): BandPref | null {
  ensurePrefs(db);
  return (db.prepare("SELECT * FROM band_prefs WHERE key = ?").get(key) as BandPref | undefined) ?? null;
}

/** Remember which Concert Archives performer a saved band is. */
export function setPrefCaSlug(db: Db, key: string, caSlug: string, now: string = new Date().toISOString()): void {
  ensurePrefs(db);
  db.prepare("UPDATE band_prefs SET ca_slug = ?, updated_at = ? WHERE key = ?").run(caSlug, now, key);
}

export function getPref(db: Db, band: BandRef): PrefStatus | null {
  ensurePrefs(db);
  const row = db.prepare("SELECT status FROM band_prefs WHERE key = ?").get(prefKey(band)) as
    | { status: PrefStatus }
    | undefined;
  return row && row.status !== "cleared" ? row.status : null;
}

/** `search` keeps names containing it, ignoring case. */
const nameFilter = (search?: string) => `%${(search ?? "").trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

export function listPrefs(
  db: Db,
  status: Exclude<PrefStatus, "cleared">,
  page: { limit?: number; offset?: number; search?: string } = {},
): BandPref[] {
  ensurePrefs(db);
  return db
    .prepare(
      `SELECT * FROM band_prefs WHERE status = ? AND name LIKE ? ESCAPE '\\'
       ORDER BY name COLLATE NOCASE LIMIT ? OFFSET ?`,
    )
    .all(status, nameFilter(page.search), page.limit ?? -1, page.offset ?? 0) as BandPref[];
}

export function countPrefs(db: Db, status: Exclude<PrefStatus, "cleared">, search?: string): number {
  ensurePrefs(db);
  return (
    db
      .prepare("SELECT COUNT(*) AS n FROM band_prefs WHERE status = ? AND name LIKE ? ESCAPE '\\'")
      .get(status, nameFilter(search)) as { n: number }
  ).n;
}

/** The artist row for each saved band, in order, created when the graph hasn't met it yet. */
export function artistIdsFor(db: Db, prefs: BandPref[]): number[] {
  return prefs.map((p) =>
    upsertArtist(db, { name: p.name, mbid: p.mbid, jambaseId: p.jambase_id, caSlug: p.ca_slug }),
  );
}

export type BulkResult = {
  liked: string[];
  already: string[];
  /** Several MusicBrainz artists share the name; pick one in the app. */
  ambiguous: { name: string; matches: number }[];
  notFound: string[];
};

type Found = { mbid: string; name: string; disambiguation: string };

/**
 * Names from a pasted list or CSV: the first column of each line, without
 * quotes, blank lines, duplicates, or a "name"/"artist" header.
 */
export function namesFromList(text: string): string[] {
  const names = text
    .split(/\r?\n/)
    .map((line) => line.split(",")[0].trim().replace(/^"(.*)"$/, "$1").trim())
    .filter(Boolean);
  if (names.length && /^(name|artist|band)s?$/i.test(names[0])) names.shift();
  const seen = new Set<string>();
  return names.filter((n) => !seen.has(normName(n)) && seen.add(normName(n)));
}

/**
 * Like many bands at once. Each name not already saved is looked up with
 * `search` (MusicBrainz, 1 per second) and liked when exactly one artist has
 * that name, or the first one when `takeFirst` is set. Re-running skips what
 * was saved before, so a long import can be stopped and resumed.
 */
export async function likeMany(
  db: Db,
  names: string[],
  search: (name: string) => Promise<Found[]>,
  opts: { takeFirst?: boolean; onProgress?: (done: number, name: string) => void } = {},
): Promise<BulkResult> {
  ensurePrefs(db);
  const result: BulkResult = { liked: [], already: [], ambiguous: [], notFound: [] };
  const saved = db.prepare("SELECT 1 FROM band_prefs WHERE lower(name) = lower(?) AND status <> 'cleared'");
  for (const [i, name] of names.entries()) {
    opts.onProgress?.(i, name);
    if (saved.get(name)) {
      result.already.push(name);
      continue;
    }
    const exact = (await search(name)).filter((a) => normName(a.name) === normName(name));
    if (exact.length === 0) {
      result.notFound.push(name);
    } else if (exact.length > 1 && !opts.takeFirst) {
      result.ambiguous.push({ name, matches: exact.length });
    } else {
      setPref(db, { name: exact[0].name, mbid: exact[0].mbid }, "liked");
      result.liked.push(name);
    }
  }
  return result;
}
