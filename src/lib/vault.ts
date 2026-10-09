/**
 * The vault: every paid API response, stored verbatim and kept forever.
 *
 * parse.bot credits are scarce and past shows don't change, so a response we
 * paid for is never thrown away or fetched again. Everything else Concert
 * Archives contributes to the database (events, appearances, the concert and
 * performer ledgers below) is derived from these rows by `rebuildConcertArchives`,
 * which means a parser fix improves old data without spending a credit, and
 * moving the vault to another machine (see portable.ts) moves everything.
 *
 * Concert Archives lists a performer's concerts newest first, future shows
 * included, so page numbers drift as new shows are added: page 3 today holds
 * different concerts than page 3 next month. The ledgers are therefore keyed
 * by concert slug, not by page.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { parseCaDate, summariseConcerts, type CaConcertRow } from "./concertArchives.ts";
import { transaction, type Db } from "./db.ts";
import { ingestConcertArchives } from "./ingest.ts";

export const VAULT_SCHEMA = `
CREATE TABLE IF NOT EXISTS payloads (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL,            -- 'parsebot'
  endpoint TEXT NOT NULL,          -- e.g. 'get_performer_concerts'
  params TEXT NOT NULL,            -- JSON object with sorted keys
  subject TEXT,                    -- display name we fetched for, e.g. 'PUP'
  fetched_at TEXT NOT NULL,
  credits INTEGER,                 -- what the call cost, when known
  body TEXT NOT NULL,              -- the response data, verbatim JSON
  sha256 TEXT NOT NULL,
  UNIQUE (source, endpoint, params, sha256)
);
`;

/** Derived from payloads; dropped and rebuilt freely. */
const LEDGER_SCHEMA = `
CREATE TABLE IF NOT EXISTS ca_concerts (
  slug TEXT PRIMARY KEY,
  date TEXT,                       -- YYYY-MM-DD, first day of a range
  title TEXT NOT NULL,
  venue TEXT NOT NULL,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL
);

-- How much of each performer's history the vault holds.
CREATE TABLE IF NOT EXISTS ca_performers (
  slug TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  pages INTEGER NOT NULL,          -- distinct page numbers fetched
  max_page INTEGER NOT NULL,       -- a resumed backfill starts after this
  reached_end INTEGER NOT NULL,    -- 1 once a page said there is no next
  concerts INTEGER NOT NULL,
  oldest_date TEXT,                -- history is complete back to here
  newest_date TEXT,
  last_fetched_at TEXT NOT NULL,
  credits INTEGER NOT NULL
);
`;

export function ensureVault(db: Db): void {
  db.exec(VAULT_SCHEMA);
  db.exec(LEDGER_SCHEMA);
}

export type PayloadInput = {
  source: "parsebot";
  endpoint: string;
  params: Record<string, string>;
  subject?: string | null;
  fetchedAt: string;
  credits?: number | null;
  /** The response data, as parsed JSON or as JSON text. */
  body: unknown;
};

export const canonicalParams = (params: Record<string, string>) =>
  JSON.stringify(Object.fromEntries(Object.entries(params).sort(([a], [b]) => a.localeCompare(b))));

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** Store a response. Returns false when an identical one is already stored. */
export function addPayload(db: Db, p: PayloadInput): boolean {
  ensureVault(db);
  const body = typeof p.body === "string" ? JSON.stringify(JSON.parse(p.body)) : JSON.stringify(p.body);
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO payloads (source, endpoint, params, subject, fetched_at, credits, body, sha256)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(p.source, p.endpoint, canonicalParams(p.params), p.subject ?? null, p.fetchedAt, p.credits ?? null, body, sha256(body));
  return result.changes > 0;
}

type ConcertsPage = { page: number; has_next: boolean; concerts: CaConcertRow[] };

type PayloadRow = { params: string; subject: string | null; fetched_at: string; credits: number | null; body: string };

/** Performer slug -> display name used when it was fetched, else the slug minus its "--5" suffix. */
function performerName(slug: string, payloads: PayloadRow[]): string {
  const named = payloads.filter((p) => p.subject).at(-1);
  return named?.subject ?? slug.replace(/--\d+$/, "");
}

/**
 * Re-derive everything Concert Archives contributes from the vault: the
 * concert and performer ledgers, and the events in the co-bill graph.
 * Where the same concert was fetched more than once (page 1 on a refresh),
 * the newest copy wins, so a future show's later lineup replaces its first one.
 */
export function rebuildConcertArchives(db: Db): { performers: number; concerts: number; shows: number } {
  ensureVault(db);
  return transaction(db, () => {
    db.exec("DELETE FROM ca_concerts; DELETE FROM ca_performers;");
    db.exec("DELETE FROM events WHERE source = 'concertarchives'");
    db.exec("DELETE FROM fetches WHERE source = 'concertarchives'");

    const rows = db
      .prepare(
        `SELECT params, subject, fetched_at, credits, body FROM payloads
         WHERE source = 'parsebot' AND endpoint = 'get_performer_concerts'
         ORDER BY fetched_at, id`,
      )
      .all() as PayloadRow[];

    const bySlug = new Map<string, PayloadRow[]>();
    for (const row of rows) {
      const slug = (JSON.parse(row.params) as { slug: string }).slug;
      bySlug.set(slug, [...(bySlug.get(slug) ?? []), row]);
    }

    const upsertConcert = db.prepare(
      `INSERT INTO ca_concerts (slug, date, title, venue, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (slug) DO UPDATE SET date = excluded.date, title = excluded.title,
         venue = excluded.venue, last_seen = excluded.last_seen`,
    );
    const insertPerformer = db.prepare(
      `INSERT INTO ca_performers (slug, name, pages, max_page, reached_end, concerts, oldest_date,
         newest_date, last_fetched_at, credits) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    let shows = 0;
    for (const [slug, payloads] of bySlug) {
      // Oldest first, so later fetches of the same concert overwrite earlier ones.
      const latest = new Map<string, CaConcertRow>();
      const pages = new Set<number>();
      let reachedEnd = false;
      for (const p of payloads) {
        const data = JSON.parse(p.body) as ConcertsPage;
        pages.add(data.page);
        if (!data.has_next) reachedEnd = true;
        for (const c of data.concerts) {
          latest.set(c.slug, c);
          upsertConcert.run(c.slug, parseCaDate(c.date), c.title, c.venue, p.fetched_at, p.fetched_at);
        }
      }

      const name = performerName(slug, payloads);
      const lastFetched = payloads.at(-1)!.fetched_at;
      const summary = summariseConcerts([...latest.values()], name);
      shows += ingestConcertArchives(db, summary, slug, lastFetched).shows;

      const dates = summary.shows.map((s) => s.date).filter((d): d is string => d !== null).sort();
      insertPerformer.run(
        slug,
        name,
        pages.size,
        Math.max(...pages),
        reachedEnd ? 1 : 0,
        latest.size,
        dates[0] ?? null,
        dates.at(-1) ?? null,
        lastFetched,
        payloads.reduce((sum, p) => sum + (p.credits ?? 0), 0),
      );
    }

    const concerts = (db.prepare("SELECT COUNT(*) AS n FROM ca_concerts").get() as { n: number }).n;
    return { performers: bySlug.size, concerts, shows };
  });
}

export type PerformerLedger = {
  slug: string;
  name: string;
  pages: number;
  max_page: number;
  reached_end: number;
  concerts: number;
  oldest_date: string | null;
  newest_date: string | null;
  last_fetched_at: string;
  credits: number;
};

export function performerLedger(db: Db): PerformerLedger[] {
  ensureVault(db);
  return db.prepare("SELECT * FROM ca_performers ORDER BY name").all() as PerformerLedger[];
}

/**
 * Add the page files scripts/concert-archives.mts cached before the vault
 * existed (data/concert-archives/raw/<slug>/concerts-page-N.json). The file's
 * modification time stands in for when it was fetched, and each page is
 * assumed to have cost the listed 2 credits. Safe to run again.
 */
export function importRawPages(db: Db, rawRoot: string): { files: number; added: number } {
  let files = 0;
  let added = 0;
  if (!existsSync(rawRoot)) return { files, added };
  const summariesDir = path.dirname(rawRoot);
  for (const slug of readdirSync(rawRoot)) {
    const dir = path.join(rawRoot, slug);
    if (!statSync(dir).isDirectory()) continue;
    let subject: string | null = null;
    try {
      subject = (JSON.parse(readFileSync(path.join(summariesDir, `${slug}.json`), "utf8")) as { seed?: string }).seed ?? null;
    } catch {
      // No summary written; the name falls back to the slug.
    }
    for (const name of readdirSync(dir)) {
      const m = name.match(/^concerts-page-(\d+)\.json$/);
      if (!m) continue;
      const file = path.join(dir, name);
      files += 1;
      const body = readFileSync(file, "utf8");
      const page = (JSON.parse(body) as { page?: number }).page ?? Number(m[1]);
      const isNew = addPayload(db, {
        source: "parsebot",
        endpoint: "get_performer_concerts",
        params: { slug, page: String(page) },
        subject,
        fetchedAt: statSync(file).mtime.toISOString(),
        credits: 2,
        body,
      });
      if (isNew) added += 1;
    }
  }
  return { files, added };
}
