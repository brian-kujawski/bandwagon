/**
 * Every upcoming concert around home, pulled from JamBase a page at a time.
 *
 * Per-band lookups only find shows for bands we already know about. This
 * pull takes in the whole area (by default 100 miles around downtown
 * Detroit), so a recommended band's local date shows up on its card even if
 * we never looked that band up, and local bills add links to the graph.
 *
 * It runs at most monthly, like the per-band refresh, and has its own cap
 * inside the JamBase budget (BANDWAGON_AREA_MONTHLY_CALLS, default 150). When
 * the cap or the budget stops it partway, the next run picks up at the next
 * page. JamBase lists soonest dates first, so a partial pull still covers the
 * coming weeks.
 *
 * JamBase's geo filter isn't confirmed live yet, so the first page of every
 * pull is checked: if its venues aren't within the radius, the pull stops
 * after that one call and waits a week before trying again.
 */
import { remainingCalls, recordCalls } from "./budget.ts";
import type { Db } from "./db.ts";
import { ingestAreaEvents } from "./ingest.ts";
import { getEventsNear, type AreaQuery, type JbEvent, type JbPagination } from "./jambase.ts";
import { milesBetween, type Home } from "./nearby.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
/** A finished pull is good for a month (decided 2026-10-09: monthly refresh). */
const FRESH_MS = 30 * DAY_MS;
/** After a pull that went wrong, wait this long before spending another call on it. */
const RETRY_MS = 7 * DAY_MS;
/** Venue coordinates and the radius are both rough; allow this much past the edge. */
const SLACK_MILES = 10;
/** The share of venues allowed past the edge before we decide the filter was ignored. */
const MAX_OUTSIDE_SHARE = 0.05;

export const AREA_SCHEMA = `
CREATE TABLE IF NOT EXISTS area_pulls (
  id INTEGER PRIMARY KEY,
  area TEXT NOT NULL,              -- "lat,lon,radius miles"
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  -- running | complete | partial (stopped by the cap or budget; resumes)
  -- | filter-ignored | error
  outcome TEXT NOT NULL,
  next_page INTEGER NOT NULL DEFAULT 1,
  total_pages INTEGER,
  calls INTEGER NOT NULL DEFAULT 0,
  concerts INTEGER NOT NULL DEFAULT 0,
  with_others INTEGER NOT NULL DEFAULT 0,
  note TEXT
);
`;

export type AreaPull = {
  id: number;
  area: string;
  started_at: string;
  updated_at: string;
  outcome: "running" | "complete" | "partial" | "filter-ignored" | "error";
  next_page: number;
  total_pages: number | null;
  calls: number;
  concerts: number;
  with_others: number;
  note: string | null;
};

export const areaKey = (home: Home) =>
  `${home.lat.toFixed(4)},${home.lon.toFixed(4)},${Math.round(home.radiusMiles)}`;

/** JamBase calls the area pull may use per calendar month, out of the overall budget. */
export function areaMonthlyCalls(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.BANDWAGON_AREA_MONTHLY_CALLS ?? 150);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 150;
}

export function lastAreaPull(db: Db, home: Home): AreaPull | null {
  db.exec(AREA_SCHEMA);
  return (
    (db
      .prepare("SELECT * FROM area_pulls WHERE area = ? ORDER BY id DESC LIMIT 1")
      .get(areaKey(home)) as AreaPull | undefined) ?? null
  );
}

/** The most recent pull that got through every page. */
export function lastCompleteAreaPull(db: Db, home: Home): AreaPull | null {
  db.exec(AREA_SCHEMA);
  return (
    (db
      .prepare("SELECT * FROM area_pulls WHERE area = ? AND outcome = 'complete' ORDER BY id DESC LIMIT 1")
      .get(areaKey(home)) as AreaPull | undefined) ?? null
  );
}

function areaCallsThisMonth(db: Db, now: Date): number {
  const month = now.toISOString().slice(0, 7);
  const row = db
    .prepare("SELECT COALESCE(SUM(calls), 0) AS n FROM area_pulls WHERE substr(updated_at, 1, 7) = ?")
    .get(month) as { n: number };
  return row.n;
}

/** Whether a pull should run now: none yet, a month since the last, or one left partway. */
export function areaPullDue(db: Db, home: Home, now: Date = new Date()): boolean {
  const last = lastAreaPull(db, home);
  if (!last) return true;
  const age = now.getTime() - Date.parse(last.updated_at);
  switch (last.outcome) {
    case "complete":
      return now.getTime() - Date.parse(last.started_at) >= FRESH_MS;
    case "partial":
      return true;
    case "running":
      // Another process is on it, or one died; give a dead one a day.
      return age >= DAY_MS;
    default:
      return age >= RETRY_MS;
  }
}

export type AreaCheck = {
  /** Events whose venue has coordinates. */
  located: number;
  /** Of those, how many are past the radius (plus slack). */
  outside: number;
  /** The farthest venue, in miles from home. */
  farthest: number;
  ok: boolean;
};

/** Did JamBase apply the radius? Looks at the venues on one page. */
export function checkArea(events: JbEvent[], home: Home): AreaCheck {
  let located = 0;
  let outside = 0;
  let farthest = 0;
  for (const e of events) {
    const lat = e.location?.geo?.latitude;
    const lon = e.location?.geo?.longitude;
    if (typeof lat !== "number" || typeof lon !== "number") continue;
    located += 1;
    const miles = milesBetween(home.lat, home.lon, lat, lon);
    farthest = Math.max(farthest, miles);
    if (miles > home.radiusMiles + SLACK_MILES) outside += 1;
  }
  // With no coordinates at all there is nothing to judge by; an empty first
  // page is fine (a quiet area), a page of unlocated venues is not.
  const ok = events.length === 0 || (located > 0 && outside / located <= MAX_OUTSIDE_SHARE);
  return { located, outside, farthest, ok };
}

export type FetchAreaPage = (
  q: AreaQuery,
  onCall: () => void,
) => Promise<{ events: JbEvent[]; pagination: JbPagination }>;

export type AreaPullOptions = {
  now?: Date;
  /** Stop after this many pages; the check command uses 1. */
  maxPages?: number;
  /** Replaces the JamBase call, for tests. */
  fetchPage?: FetchAreaPage;
  /** Progress lines, for the command line. */
  log?: (line: string) => void;
};

export type AreaPullResult = {
  pull: AreaPull;
  /** The first page's venue check, when this run fetched page 1. */
  check: AreaCheck | null;
  /** Calls made by this run. */
  calls: number;
  /** Why this run stopped before the last page, if it did. */
  stoppedBy: "area-cap" | "budget" | "max-pages" | null;
};

/**
 * Pull the area's upcoming concerts, resuming a partial pull if there is
 * one. Each page is stored and counted against the budget as it arrives, so
 * an interrupted run loses nothing it paid for.
 */
export async function pullArea(db: Db, home: Home, opts: AreaPullOptions = {}): Promise<AreaPullResult> {
  const now = opts.now ?? new Date();
  const log = opts.log ?? (() => {});
  const fetchPage = opts.fetchPage ?? getEventsNear;
  db.exec(AREA_SCHEMA);

  const at = () => (opts.now ?? new Date()).toISOString();
  const last = lastAreaPull(db, home);
  let pull: AreaPull;
  if (last && last.outcome === "partial") {
    db.prepare("UPDATE area_pulls SET outcome = 'running', updated_at = ? WHERE id = ?").run(at(), last.id);
    pull = { ...last, outcome: "running" };
    log(`resuming the pull from ${last.started_at.slice(0, 10)} at page ${last.next_page}`);
  } else {
    const row = db
      .prepare(
        "INSERT INTO area_pulls (area, started_at, updated_at, outcome) VALUES (?, ?, ?, 'running') RETURNING *",
      )
      .get(areaKey(home), at(), at()) as AreaPull;
    pull = row;
  }

  const save = (fields: Partial<AreaPull>) => {
    pull = { ...pull, ...fields, updated_at: at() };
    db.prepare(
      `UPDATE area_pulls SET updated_at = ?, outcome = ?, next_page = ?, total_pages = ?, calls = ?,
         concerts = ?, with_others = ?, note = ? WHERE id = ?`,
    ).run(
      pull.updated_at,
      pull.outcome,
      pull.next_page,
      pull.total_pages,
      pull.calls,
      pull.concerts,
      pull.with_others,
      pull.note,
      pull.id,
    );
  };

  const from = pull.started_at.slice(0, 10);
  let calls = 0;
  let check: AreaCheck | null = null;
  let stoppedBy: AreaPullResult["stoppedBy"] = null;

  for (;;) {
    const page = pull.next_page;
    if (pull.total_pages !== null && page > pull.total_pages) {
      save({ outcome: "complete" });
      break;
    }
    if (opts.maxPages !== undefined && calls >= opts.maxPages) stoppedBy = "max-pages";
    else if (areaCallsThisMonth(db, now) >= areaMonthlyCalls()) stoppedBy = "area-cap";
    else if (remainingCalls(db, "jambase", now) < 1) stoppedBy = "budget";
    if (stoppedBy) {
      save({ outcome: "partial" });
      break;
    }

    let result: Awaited<ReturnType<FetchAreaPage>>;
    let called = false;
    try {
      const q = { lat: home.lat, lon: home.lon, radiusMiles: home.radiusMiles, from, page };
      result = await fetchPage(q, () => {
        // Counted before the request goes out, so a crash can't hide a call.
        called = true;
        calls += 1;
        recordCalls(db, "jambase", 1, now);
        save({ calls: pull.calls + 1 });
      });
    } catch (e) {
      // Nothing went out (no key, say): leave it to resume next time.
      if (!called) save({ outcome: "partial" });
      else save({ outcome: "error", note: e instanceof Error ? e.message : String(e) });
      throw e;
    }

    if (page === 1) {
      check = checkArea(result.events, home);
      if (!check.ok) {
        const note =
          check.located === 0
            ? "no venue coordinates on the first page"
            : `${check.outside} of ${check.located} venues past ${home.radiusMiles} miles (farthest ${Math.round(check.farthest)})`;
        log(`JamBase didn't apply the area filter: ${note}. Nothing stored.`);
        save({ outcome: "filter-ignored", note });
        break;
      }
    }

    const counts = ingestAreaEvents(db, result.events, at());
    const totalPages = result.pagination.totalPages ?? (result.events.length < 100 ? page : null);
    log(
      `page ${page}${totalPages ? ` of ${totalPages}` : ""}: ${counts.concerts} concerts, ` +
        `${counts.withOthers} with more than one act`,
    );
    save({
      next_page: page + 1,
      total_pages: totalPages,
      concerts: pull.concerts + counts.concerts,
      with_others: pull.with_others + counts.withOthers,
    });
    if (result.events.length === 0) {
      save({ outcome: "complete", total_pages: pull.total_pages ?? page });
      break;
    }
  }
  return { pull, check, calls, stoppedBy };
}
