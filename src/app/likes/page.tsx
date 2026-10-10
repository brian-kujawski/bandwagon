import Link from "next/link";
import { after, connection } from "next/server";
import { pickHistoryPerformer, setBandPref, startHistoryCheck } from "../actions";
import { AutoRefresh } from "./auto-refresh";
import {
  candidatesOf,
  clientFromEnv,
  getCheck,
  historyComplete,
  HISTORY_YEARS,
  ledgerFor,
  maxCreditsPerCheck,
  pendingChecks,
  runQueuedChecks,
  type BackfillRow,
} from "@/lib/backfill";
import { getDb } from "@/lib/db";
import { parseBotConfig } from "@/lib/parsebot";
import { countPrefs, listPrefs, type BandPref } from "@/lib/prefs";
import type { PerformerLedger } from "@/lib/vault";

const PAGE_SIZE = 100;

const one = (raw: string | string[] | undefined) => (Array.isArray(raw) ? raw[0] : raw)?.trim() ?? "";

function formatDate(iso: string | null): string {
  if (!iso) return "?";
  const d = new Date(iso.length === 10 ? `${iso}T12:00:00Z` : iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

/** The URL of this page with some parameters changed; undefined drops one. */
function href(base: Record<string, string>, change: Record<string, string | undefined>): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...base, ...change })) if (v) params.set(k, v);
  const qs = params.toString();
  return qs ? `/likes?${qs}` : "/likes";
}

/** One line on what the vault holds for a band, and how its latest check went. */
function HistoryStatus({ ledger, check, now }: { ledger: PerformerLedger | null; check: BackfillRow | null; now: Date }) {
  if (check?.state === "queued") {
    return <div className="meta history">Concert history check queued. It starts once any check ahead of it is done.</div>;
  }
  if (check?.state === "running") {
    return (
      <div className="meta history">
        Checking concert history: {check.progress ?? "starting"}… ({check.credits} credits so far)
      </div>
    );
  }
  const stored = ledger
    ? `${ledger.concerts} shows stored, ${formatDate(ledger.oldest_date)} to ${formatDate(ledger.newest_date)}` +
      (historyComplete(ledger, now) ? "" : `, not yet back ${HISTORY_YEARS} years`) +
      `. Last checked ${formatDate(ledger.last_fetched_at)}.`
    : "Concert history not checked yet.";
  return (
    <>
      <div className="meta history">{stored}</div>
      {check?.state === "failed" && <div className="meta history problem">Last check didn&apos;t finish: {check.message}</div>}
      {check?.state === "done" && check.finished_at && (
        <div className="meta history">
          Latest check {formatDate(check.finished_at)} used {check.credits} credits. {check.message}
        </div>
      )}
    </>
  );
}

function checkLabel(ledger: PerformerLedger | null, now: Date): string {
  if (!ledger) return "Check concert history";
  return historyComplete(ledger, now) ? "Check for new shows" : "Continue history check";
}

export default async function Likes({ searchParams }: PageProps<"/likes">) {
  await connection(); // reads the database on every request, never at build time
  const params = await searchParams;
  const tab = one(params.list) === "hidden" ? "hidden" : "liked";
  const q = one(params.q);
  const confirming = one(params.check);
  const pageNo = Math.max(1, Math.floor(Number(one(params.page)) || 1));
  const base: Record<string, string> = {
    ...(tab === "hidden" ? { list: "hidden" } : {}),
    ...(q ? { q } : {}),
    ...(pageNo > 1 ? { page: String(pageNo) } : {}),
  };
  const here = href(base, {});

  const db = getDb();
  const now = new Date();
  const status = tab === "liked" ? "liked" : "not_interested";
  const likedCount = countPrefs(db, "liked");
  const hiddenCount = countPrefs(db, "not_interested");
  const matching = countPrefs(db, status, q);
  const prefs = listPrefs(db, status, { limit: PAGE_SIZE, offset: (pageNo - 1) * PAGE_SIZE, search: q });
  const lastPage = Math.max(1, Math.ceil(matching / PAGE_SIZE));

  const canCheck = parseBotConfig() !== null;
  const cap = maxCreditsPerCheck();
  const pending = pendingChecks(db);
  // Checks queued before a restart carry on once the page is open again.
  if (pending > 0 && canCheck) after(() => runQueuedChecks(getDb(), clientFromEnv()));

  const removeForm = (p: BandPref, label: string) => (
    <form action={setBandPref}>
      <input type="hidden" name="name" value={p.name} />
      {p.mbid && <input type="hidden" name="mbid" value={p.mbid} />}
      <button type="submit" name="status" value="cleared" className="small-button">
        {label}
      </button>
    </form>
  );

  const likedRow = (p: BandPref) => {
    const ledger = ledgerFor(db, p.ca_slug);
    const check = getCheck(db, p.key);
    const busy = check?.state === "queued" || check?.state === "running";
    const candidates = candidatesOf(check);
    return (
      <li key={p.key} className="card band-row">
        <div className="card-head">
          <div>
            <div className="card-title">{p.name}</div>
            <HistoryStatus ledger={ledger} check={check} now={now} />
          </div>
          <div className="row-actions">
            {canCheck && !busy && candidates.length === 0 && (
              <Link className="small-button" href={href(base, { check: p.key })} scroll={false}>
                {checkLabel(ledger, now)}
              </Link>
            )}
            {removeForm(p, "Remove from likes")}
          </div>
        </div>

        {confirming === p.key && !busy && (
          <div className="confirm" role="alertdialog" aria-labelledby={`confirm-${p.key}`}>
            <p id={`confirm-${p.key}`}>
              <strong>Warning:</strong> this will use limited and fairly expensive API credits. Are you sure you want
              to check the concert history for <strong>{p.name}</strong>?
            </p>
            <p className="meta">
              It looks back {HISTORY_YEARS} years and stops at {cap} credits (2 credits per page of about 50 shows
              {p.ca_slug ? "" : ", plus 2 to find the band on Concert Archives"}).
              {ledger ? ` Last checked ${formatDate(ledger.last_fetched_at)}.` : ""}
            </p>
            <div className="confirm-actions">
              <form action={startHistoryCheck}>
                <input type="hidden" name="key" value={p.key} />
                <input type="hidden" name="back" value={here} />
                <button type="submit" className="danger-button">
                  Yes, use credits
                </button>
              </form>
              <Link href={here} scroll={false} className="small-button">
                Cancel
              </Link>
            </div>
          </div>
        )}

        {candidates.length > 0 && (
          <div className="confirm">
            <p>{check?.message}</p>
            <ul className="candidates">
              {candidates.map((c) => (
                <li key={c.slug}>
                  <form action={pickHistoryPerformer}>
                    <input type="hidden" name="key" value={p.key} />
                    <input type="hidden" name="slug" value={c.slug} />
                    <input type="hidden" name="back" value={here} />
                    <button type="submit" className="small-button">
                      Check this one
                    </button>
                  </form>
                  <a href={`https://www.concertarchives.org/bands/${c.slug}`}>{c.name}</a>
                  <span className="meta"> · {c.concert_count} concerts</span>
                </li>
              ))}
            </ul>
            <p className="meta">Picking one goes ahead with the check you confirmed, up to {cap} credits.</p>
          </div>
        )}
      </li>
    );
  };

  return (
    <>
      {pending > 0 && <AutoRefresh />}
      <h1>Your bands</h1>
      <p className="lede">
        {likedCount === 0
          ? "You haven't liked any bands yet."
          : `You like ${likedCount} ${likedCount === 1 ? "band" : "bands"}. `}
        {likedCount > 0 && <Link href="/bands">See bands like them →</Link>}
      </p>

      <nav className="tabs" aria-label="Lists">
        <Link href={href({}, {})} aria-current={tab === "liked" ? "page" : undefined}>
          Liked ({likedCount})
        </Link>
        <Link href={href({}, { list: "hidden" })} aria-current={tab === "hidden" ? "page" : undefined}>
          Not interested ({hiddenCount})
        </Link>
        <Link href="/">Add bands</Link>
      </nav>

      {tab === "liked" && !canCheck && likedCount > 0 && (
        <p className="notice">
          To check a band&apos;s concert history on Concert Archives, add <code>PARSE_API_KEY</code> and{" "}
          <code>PARSE_SCRAPER_ID</code> to <code>.env.local</code> and restart the app.
        </p>
      )}

      {(tab === "liked" ? likedCount : hiddenCount) > PAGE_SIZE / 4 && (
        <form className="search" action="/likes" method="get">
          {tab === "hidden" && <input type="hidden" name="list" value="hidden" />}
          <input name="q" defaultValue={q} placeholder="Find a band in this list" aria-label="Find a band" />
          <button type="submit">Find</button>
        </form>
      )}

      {q && matching === 0 && (
        <p className="notice">
          No bands in this list match <strong>{q}</strong>.
        </p>
      )}

      <ul className="list">
        {tab === "liked"
          ? prefs.map(likedRow)
          : prefs.map((p) => (
              <li key={p.key} className="card band-row">
                <div className="card-head">
                  <div className="card-title">{p.name}</div>
                  <div className="row-actions">{removeForm(p, "Show again")}</div>
                </div>
              </li>
            ))}
      </ul>

      {lastPage > 1 && (
        <nav className="pager" aria-label="Pages">
          {pageNo > 1 ? <Link href={href(base, { page: String(pageNo - 1) })}>← Previous</Link> : <span />}
          <span className="meta">
            Page {pageNo} of {lastPage}
          </span>
          {pageNo < lastPage ? <Link href={href(base, { page: String(pageNo + 1) })}>Next →</Link> : <span />}
        </nav>
      )}
    </>
  );
}
