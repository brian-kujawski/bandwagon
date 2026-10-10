import Link from "next/link";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { PrefButtons } from "../pref-buttons";
import { getDb } from "@/lib/db";
import type { CSSProperties } from "react";
import {
  describeBridge,
  describeDirect,
  matchScore,
  type GraphCandidate,
  type GraphPage,
  type LinkShow,
} from "@/lib/graph";
import { recommendForProfile, type ProfileOutcome } from "@/lib/recommend";

const MAX_SHOWS_LISTED = 3;
const MAX_LINKS_LISTED = 3;
const MAX_BRIDGES_LISTED = 2;
const PAGE_SIZE = 25;

/** "?page=2" -> 1 (zero-based), anything odd -> 0. */
function pageParam(raw: string | string[] | undefined): number {
  const n = Number(Array.isArray(raw) ? raw[0] : raw);
  return Number.isInteger(n) && n > 1 ? n - 1 : 0;
}

function formatDate(iso: string | null): string {
  if (!iso) return "Date unknown";
  const d = new Date(`${iso}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

function ShowLine({ show }: { show: LinkShow }) {
  const text = `${formatDate(show.date)} · ${[show.venue, show.city].filter(Boolean).join(", ")}`;
  return <li>{show.url ? <a href={show.url}>{text}</a> : text}</li>;
}

function refreshNotes(o: ProfileOutcome): string[] {
  return o.refreshed.flatMap(({ name, status }) =>
    status.kind === "not-on-jambase"
      ? [`${name} isn't listed on JamBase, so only stored shows are used for them.`]
      : status.kind === "error"
        ? [`JamBase didn't answer for ${name}; using stored shows only.`]
        : [],
  );
}

/** Amber (hue 35) for a weak match up to green (hue 140) for a strong one. */
const matchHue = (match: number) => Math.round(35 + ((match - 1) / 99) * 105);

function Candidate({ c, today }: { c: GraphCandidate; today: string }) {
  const match = matchScore(c.score);
  const hue = { "--match-hue": matchHue(match) } as CSSProperties;
  const band = { name: c.artist.name, mbid: c.artist.mbid, jambaseId: c.artist.jambase_id, caSlug: c.artist.ca_slug };
  const name = c.artist.url ? <a href={c.artist.url}>{c.artist.name}</a> : c.artist.name;
  const shows = c.direct.flatMap((d) => d.shows);
  // Explain through other acts when that's most of why the band is here.
  const showBridges = c.bridges.length > 0 && (c.direct.length === 0 || c.bridged > c.score / 2);
  return (
    <li className="card match-card" style={hue}>
      <div className="card-head">
        <div className="card-title">{name}</div>
        <span className="match" title={`Match ${match} of 100`} aria-label={`Match ${match} of 100`}>
          {match}
        </span>
      </div>
      {c.direct.slice(0, MAX_LINKS_LISTED).map((d) => (
        <div key={d.seed.id} className="why">
          {describeDirect(d, today)}
        </div>
      ))}
      {c.direct.length > MAX_LINKS_LISTED && (
        <div className="why meta">and with {c.direct.length - MAX_LINKS_LISTED} more of your bands</div>
      )}
      {showBridges &&
        c.bridges.slice(0, MAX_BRIDGES_LISTED).map((b) => (
          <div key={`${b.seed.id}-${b.bridge.id}`} className="why">
            {describeBridge(b)}
          </div>
        ))}
      {shows.length > 0 && (
        <ul className="shows">
          {shows.slice(0, MAX_SHOWS_LISTED).map((s, i) => (
            <ShowLine key={i} show={s} />
          ))}
          {shows.length > MAX_SHOWS_LISTED && <li>and {shows.length - MAX_SHOWS_LISTED} more</li>}
        </ul>
      )}
      {showBridges && c.bridges.length > MAX_BRIDGES_LISTED && (
        <p className="meta">and {c.bridges.length - MAX_BRIDGES_LISTED} more links like these</p>
      )}
      <PrefButtons band={band} current={null} />
    </li>
  );
}

/** Previous / next links. */
function Pager({ page, index }: { page: GraphPage; index: number }) {
  const pages = Math.ceil(page.total / PAGE_SIZE);
  if (pages <= 1) return null;
  const href = (i: number) => (i > 0 ? `/bands?page=${i + 1}` : "/bands");
  return (
    <p className="pager meta">
      {index > 0 ? <Link href={href(index - 1)}>← Previous</Link> : <span />}
      <span>
        Page {index + 1} of {pages} ({page.total} acts)
      </span>
      {index < pages - 1 ? <Link href={href(index + 1)}>Next →</Link> : <span />}
    </p>
  );
}

export default async function BandsPage({ searchParams }: PageProps<"/bands">) {
  await connection(); // reads the database on every request, never at build time
  const params = await searchParams;
  const index = pageParam(params.page);
  const outcome = await recommendForProfile(getDb(), new Date(), { page: index, size: PAGE_SIZE });
  if (outcome.liked === 0) redirect("/");
  const { results, today, noKey, budget } = outcome;
  const notes = refreshNotes(outcome);
  const names = outcome.liked === 1 ? "the band you like" : `the ${outcome.liked} bands you like`;

  return (
    <>
      <h1>Bands like {names}</h1>
      <p className="lede">
        <Link href="/">Add or remove bands</Link>
      </p>

      {noKey && (
        <p className="notice">
          This server has no JamBase key, so only shows already stored are used. Set{" "}
          <code>JAMBASE_API_KEY</code> in <code>.env.local</code> and restart to fetch upcoming
          shows.
        </p>
      )}
      {notes.length > 0 && (
        <ul className="meta notes">
          {notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}

      {results.total === 0 && (
        <>
          <p className="notice">
            Nothing to go on yet: no shared bills are on record for {names}. Bands announce tours
            in batches, so check back later.
          </p>
          <p className="meta" style={{ marginTop: "1rem" }}>
            <Link href="/">Try another band</Link>, maybe one they&apos;ve toured with before.
          </p>
        </>
      )}

      {results.total > 0 && (
        <>
          <ol className="list" start={index * PAGE_SIZE + 1}>
            {results.candidates.map((c) => (
              <Candidate key={c.artist.id} c={c} today={today} />
            ))}
          </ol>
          <Pager page={results} index={index} />
          <p className="meta" style={{ marginTop: "1.5rem" }}>
            Ranked by how many of your bands they share bills with, directly or through the acts
            your bands play with. The match number runs from 1 to 100: green means links to many
            of your bands, amber a single distant link. Upcoming dates count a little more than past ones. From upcoming
            concerts on JamBase plus any history stored locally. Festivals are left out.
          </p>
        </>
      )}
      <p className="meta" style={{ marginTop: "0.5rem" }}>
        {outcome.waiting > 0 &&
          `${outcome.waiting} of your bands are due a JamBase check; a few get one each visit. `}
        JamBase calls this month: {budget.used} of {budget.limit}.
      </p>
    </>
  );
}
