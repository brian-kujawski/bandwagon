/**
 * Concert history checks: fetch a liked band's last five years of shows from
 * Concert Archives (through parse.bot), one band at a time, only when the user
 * asks and confirms. Credits are limited and fairly expensive, so a check:
 *
 *   - finds the band's Concert Archives performer once (search_performers,
 *     2 credits), reusing a search the vault already holds, and asks the user
 *     to pick when the name matches more than one performer or none exactly
 *   - pages through get_performer_concerts (2 credits per ~50 shows) newest
 *     first until it reaches shows five years old, the end of the list, or
 *     the per-check credit limit
 *   - on a later check, refetches the top of the list for new shows, and as
 *     soon as a page overlaps what the vault holds, jumps past the deepest
 *     page already stored, so no stored page is paid for twice
 *   - stores every response in the vault (vault.ts) and rebuilds the graph
 *
 * The `ca_backfill` table is this machine's record of checks (queued,
 * running, done, failed, or waiting for a pick). What a check fetched lives in
 * the vault, so it travels in exports even though this table doesn't.
 */
import { normName, parseCaDate, type CaConcertRow } from "./concertArchives.ts";
import { upsertArtist, type Db } from "./db.ts";
import { parseBotClient, parseBotConfig, PRICES, type Endpoint, type ParseBotClient } from "./parsebot.ts";
import { getPrefByKey, setPrefCaSlug, type BandPref } from "./prefs.ts";
import { addPayload, canonicalParams, ensureVault, rebuildConcertArchives, type PerformerLedger } from "./vault.ts";

/** How far back a check reaches. */
export const HISTORY_YEARS = 5;

export const BACKFILL_SCHEMA = `
CREATE TABLE IF NOT EXISTS ca_backfill (
  key TEXT PRIMARY KEY,            -- band_prefs.key
  name TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'done', 'failed', 'pick')),
  progress TEXT,                   -- what a running check is doing
  candidates TEXT,                 -- JSON performers to pick from, when state = 'pick'
  credits INTEGER NOT NULL DEFAULT 0,  -- spent by the latest check
  queued_at TEXT NOT NULL,
  finished_at TEXT,
  message TEXT                     -- how the latest check ended
);
`;

export type CheckState = "queued" | "running" | "done" | "failed" | "pick";

export type Performer = { name: string; slug: string; concert_count: number };

export type BackfillRow = {
  key: string;
  name: string;
  state: CheckState;
  progress: string | null;
  candidates: string | null;
  credits: number;
  queued_at: string;
  finished_at: string | null;
  message: string | null;
};

export function ensureBackfill(db: Db): void {
  ensureVault(db);
  db.exec(BACKFILL_SCHEMA);
}

/** Credits one check may spend. Override with PARSE_CHECK_MAX_CREDITS. */
export function maxCreditsPerCheck(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.PARSE_CHECK_MAX_CREDITS ?? 30);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 30;
}

/** The oldest date a check needs to reach, as YYYY-MM-DD. */
export function historyCutoff(now: Date, years: number = HISTORY_YEARS): string {
  const d = new Date(now);
  d.setUTCFullYear(d.getUTCFullYear() - years);
  return d.toISOString().slice(0, 10);
}

export function getCheck(db: Db, key: string): BackfillRow | null {
  ensureBackfill(db);
  return (db.prepare("SELECT * FROM ca_backfill WHERE key = ?").get(key) as BackfillRow | undefined) ?? null;
}

export function candidatesOf(row: BackfillRow | null): Performer[] {
  return row?.state === "pick" && row.candidates ? (JSON.parse(row.candidates) as Performer[]) : [];
}

const update = (db: Db, key: string, fields: Partial<Omit<BackfillRow, "key">>) => {
  const cols = Object.keys(fields);
  db.prepare(`UPDATE ca_backfill SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE key = ?`).run(
    ...cols.map((c) => fields[c as keyof typeof fields] ?? null),
    key,
  );
};

/**
 * Queue a check for a liked band. Returns false when one is already queued or
 * running, or the band isn't liked.
 */
export function queueCheck(db: Db, key: string, now: Date = new Date()): boolean {
  ensureBackfill(db);
  const pref = getPrefByKey(db, key);
  if (!pref || pref.status !== "liked") return false;
  const current = getCheck(db, key);
  if (current && (current.state === "queued" || current.state === "running")) return false;
  db.prepare(
    `INSERT INTO ca_backfill (key, name, state, queued_at) VALUES (?, ?, 'queued', ?)
     ON CONFLICT (key) DO UPDATE SET name = excluded.name, state = 'queued', progress = NULL,
       candidates = NULL, credits = 0, queued_at = excluded.queued_at, finished_at = NULL, message = NULL`,
  ).run(key, pref.name, now.toISOString());
  return true;
}

/** The user picked which Concert Archives performer a band is; queue its check. */
export function pickPerformer(db: Db, key: string, slug: string, now: Date = new Date()): boolean {
  const row = getCheck(db, key);
  if (!candidatesOf(row).some((p) => p.slug === slug)) return false;
  setPrefCaSlug(db, key, slug, now.toISOString());
  return queueCheck(db, key, now);
}

/** Which performer a band is: one exact name match, or a few to pick from. */
export function choosePerformer(results: Performer[], name: string): { slug: string } | { candidates: Performer[] } {
  const exact = results.filter((r) => normName(r.name) === normName(name));
  if (exact.length === 1) return { slug: exact[0].slug };
  const pool = exact.length > 1 ? exact : results;
  return { candidates: [...pool].sort((a, b) => b.concert_count - a.concert_count).slice(0, 6) };
}

type ConcertsPage = { page: number; has_next: boolean; concerts: CaConcertRow[] };

/** What the vault already holds for a performer. */
function storedPages(db: Db, slug: string): { maxPage: number; known: Set<string> } {
  const rows = db
    .prepare(
      `SELECT params, body FROM payloads WHERE source = 'parsebot' AND endpoint = 'get_performer_concerts'`,
    )
    .all() as { params: string; body: string }[];
  let maxPage = 0;
  const known = new Set<string>();
  for (const r of rows) {
    if ((JSON.parse(r.params) as { slug?: string }).slug !== slug) continue;
    const page = JSON.parse(r.body) as ConcertsPage;
    maxPage = Math.max(maxPage, page.page);
    for (const c of page.concerts) known.add(c.slug);
  }
  return { maxPage, known };
}

function storedSearch(db: Db, params: Record<string, string>): Performer[] | null {
  const row = db
    .prepare(
      `SELECT body FROM payloads WHERE source = 'parsebot' AND endpoint = 'search_performers' AND params = ?
       ORDER BY fetched_at DESC LIMIT 1`,
    )
    .get(canonicalParams(params)) as { body: string } | undefined;
  return row ? (JSON.parse(row.body) as { results: Performer[] }).results : null;
}

export function ledgerFor(db: Db, slug: string | null): PerformerLedger | null {
  if (!slug) return null;
  ensureBackfill(db);
  return (db.prepare("SELECT * FROM ca_performers WHERE slug = ?").get(slug) as PerformerLedger | undefined) ?? null;
}

/** True once the vault reaches back `years`, or holds the performer's whole list. */
export function historyComplete(ledger: PerformerLedger | null, now: Date, years: number = HISTORY_YEARS): boolean {
  if (!ledger) return false;
  return ledger.reached_end === 1 || (ledger.oldest_date !== null && ledger.oldest_date <= historyCutoff(now, years));
}

export type CheckOptions = {
  now?: Date;
  maxCredits?: number;
  years?: number;
  log?: (line: string) => void;
};

/** Run one queued check to its end. Never throws; the outcome is in ca_backfill. */
export async function runCheck(db: Db, key: string, client: ParseBotClient, opts: CheckOptions = {}): Promise<BackfillRow> {
  ensureBackfill(db);
  const now = opts.now ?? new Date();
  const cap = opts.maxCredits ?? maxCreditsPerCheck();
  const years = opts.years ?? HISTORY_YEARS;
  const log = opts.log ?? (() => {});
  const pref = getPrefByKey(db, key) as BandPref;
  let spent = 0;
  let fetched = 0;

  const finish = (state: CheckState, message: string, extra: Partial<BackfillRow> = {}) => {
    update(db, key, { state, message, progress: null, credits: spent, finished_at: new Date().toISOString(), ...extra });
    log(`${pref?.name ?? key}: ${message}`);
    return getCheck(db, key)!;
  };

  if (!pref || pref.status !== "liked") return finish("failed", "This band isn't in your likes any more.");
  update(db, key, { state: "running", progress: "Starting", message: null, credits: 0 });

  const afford = (endpoint: Endpoint) => spent + PRICES[endpoint] <= cap;
  const call = async (endpoint: Endpoint, params: Record<string, string>, progress: string) => {
    update(db, key, { progress });
    const r = await client.call(endpoint, params);
    // parse.bot's charge header isn't always there; count the list price at least.
    const cost = Math.max(r.credits, PRICES[endpoint]);
    spent += cost;
    fetched += 1;
    addPayload(db, {
      source: "parsebot",
      endpoint,
      params,
      subject: pref.name,
      fetchedAt: new Date().toISOString(),
      credits: cost,
      body: r.data,
    });
    update(db, key, { credits: spent });
    return r.data;
  };

  try {
    let slug = pref.ca_slug;
    if (!slug) {
      const params = { query: pref.name };
      let results = storedSearch(db, params);
      if (!results) {
        if (!afford("search_performers")) return finish("failed", `Searching costs more than the ${cap}-credit limit.`);
        results = ((await call("search_performers", params, "Finding the band on Concert Archives")) as {
          results: Performer[];
        }).results;
      }
      if (results.length === 0) return finish("failed", "Concert Archives has no performer by this name.");
      const choice = choosePerformer(results, pref.name);
      if ("candidates" in choice) {
        return finish("pick", "Several Concert Archives performers could be this band. Pick the right one.", {
          candidates: JSON.stringify(choice.candidates),
        });
      }
      slug = choice.slug;
      setPrefCaSlug(db, key, slug);
    }
    upsertArtist(db, { name: pref.name, mbid: pref.mbid, jambaseId: pref.jambase_id, caSlug: slug });

    const cutoff = historyCutoff(now, years);
    const before = ledgerFor(db, slug);
    const wasComplete = historyComplete(before, now, years);
    const stored = storedPages(db, slug);

    let page = 1;
    let stop: "end" | "depth" | "cap";
    for (;;) {
      if (!afford("get_performer_concerts")) {
        stop = "cap";
        break;
      }
      const data = (await call("get_performer_concerts", { slug, page: String(page) }, `Fetching page ${page}`)) as ConcertsPage;
      if (!data.has_next || data.concerts.length === 0) {
        stop = "end";
        break;
      }
      const dates = data.concerts.map((c) => parseCaDate(c.date)).filter((d): d is string => d !== null).sort();
      if (dates.length && dates[0] <= cutoff) {
        stop = "depth";
        break;
      }
      // The list grows at the top. Once a page shows concerts we already hold,
      // everything down to the deepest stored page is covered.
      const overlaps = data.concerts.some((c) => stored.known.has(c.slug));
      if (overlaps && page <= stored.maxPage) {
        if (wasComplete) {
          stop = "depth";
          break;
        }
        page = stored.maxPage + 1;
      } else {
        page += 1;
      }
    }

    rebuildConcertArchives(db);
    const message =
      stop === "cap"
        ? `Stopped at the ${cap}-credit limit for one check; check again to go further back.`
        : stop === "end"
          ? "That's the band's whole Concert Archives history."
          : `Reached ${years} years back.`;
    return finish("done", message);
  } catch (e) {
    if (fetched > 0) rebuildConcertArchives(db);
    return finish("failed", e instanceof Error ? e.message : String(e));
  }
}

type Runner = { bandwagonHistoryRun?: Promise<void> | null };

/**
 * Work through queued checks one at a time, oldest first. Calling it while
 * a run is going returns that run, which picks up anything queued meanwhile.
 */
export function runQueuedChecks(db: Db, client: ParseBotClient | null, opts: CheckOptions = {}): Promise<void> {
  const g = globalThis as Runner;
  if (g.bandwagonHistoryRun) return g.bandwagonHistoryRun;
  if (!client) return Promise.resolve();
  ensureBackfill(db);
  // Nothing is running in this process, so a 'running' row is left from a restart.
  db.prepare(
    `UPDATE ca_backfill SET state = 'failed', progress = NULL, finished_at = ?,
       message = 'Interrupted when the app stopped. Credits already spent are kept in the vault.'
     WHERE state = 'running'`,
  ).run(new Date().toISOString());
  if (pendingChecks(db) === 0) return Promise.resolve();

  g.bandwagonHistoryRun = (async () => {
    for (;;) {
      const next = db.prepare("SELECT key FROM ca_backfill WHERE state = 'queued' ORDER BY queued_at LIMIT 1").get() as
        | { key: string }
        | undefined;
      if (!next) return;
      await runCheck(db, next.key, client, opts);
    }
  })()
    .catch((e) => console.error("[history]", e))
    .finally(() => {
      g.bandwagonHistoryRun = null;
    });
  return g.bandwagonHistoryRun;
}

/** Checks queued or running. */
export function pendingChecks(db: Db): number {
  ensureBackfill(db);
  return (db.prepare("SELECT COUNT(*) AS n FROM ca_backfill WHERE state IN ('queued', 'running')").get() as { n: number }).n;
}

/** A parse.bot client from PARSE_API_KEY and PARSE_SCRAPER_ID, or null without them. */
export function clientFromEnv(env: NodeJS.ProcessEnv = process.env): ParseBotClient | null {
  const config = parseBotConfig(env);
  if (!config) return null;
  const delay = Number(env.PARSE_CALL_DELAY_SECONDS ?? 10);
  return parseBotClient(config, {
    delayMs: (Number.isFinite(delay) && delay >= 0 ? delay : 10) * 1000,
    log: (line) => console.info(`[history] ${line}`),
  });
}
