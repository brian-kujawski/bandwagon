import Link from "next/link";
import { after, connection } from "next/server";
import type { CSSProperties, ReactNode } from "react";
import { getArtistRow, getDb, transaction } from "@/lib/db";
import { matchScore, suggestionScores } from "@/lib/graph";
import { concertsFor, homeFromEnv, type ConcertShow } from "@/lib/nearby";
import { artistIdsFor, listPrefs } from "@/lib/prefs";
import { refreshAreaIfDue } from "@/lib/recommend";
import { spotifyLinks, spotifySearchUrl } from "@/lib/spotify";

const MAX_OTHERS_LISTED = 6;

const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const noon = (iso: string) => new Date(`${iso}T12:00:00Z`);

function formatDay(iso: string): string {
  return noon(iso).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
}

function formatMonth(iso: string): string {
  return noon(iso).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}

/** "a, b and c" */
function and(items: ReactNode[]): ReactNode {
  return items.map((item, i) => (
    <span key={i}>
      {i > 0 && (i === items.length - 1 ? " and " : ", ")}
      {item}
    </span>
  ));
}

/** Amber (hue 35) for a weak match up to green (hue 140), as on Suggestions. */
const matchHue = (match: number) => Math.round(35 + ((match - 1) / 99) * 105);

function Show({ show, listen }: { show: ConcertShow; listen: Map<string, string> }) {
  const named = new Set([...show.liked, ...show.suggested.map((s) => s.name)]);
  const others = show.lineup.filter((n) => !named.has(n));
  const place = [show.venue, show.city].filter(Boolean).join(", ");
  const suggested = show.suggested.map((s) => (
    <a
      key={s.name}
      href={listen.get(s.name) ?? spotifySearchUrl(s.name)}
      target="_blank"
      rel="noopener noreferrer"
      title={`Listen to ${s.name} on Spotify`}
    >
      {s.name}
    </a>
  ));
  // A show none of your bands play is there for a suggestion: badge it like one.
  const match = show.liked.length === 0 ? matchScore(Math.max(...show.suggested.map((s) => s.score))) : null;
  const hue = match ? ({ "--match-hue": matchHue(match) } as CSSProperties) : undefined;
  return (
    <li className={match ? "card match-card" : "card"} style={hue}>
      <div className="card-head">
        <div className="card-title">{show.liked.length > 0 ? and(show.liked) : and(suggested)}</div>
        <span className="concert-when">
          {match && (
            <span className="match" title={`Suggested, match ${match} of 100`} aria-label={`Suggested, match ${match} of 100`}>
              {match}
            </span>
          )}
          <span className="meta">{formatDay(show.date)}</span>
        </span>
      </div>
      {show.liked.length > 0 && suggested.length > 0 && <div className="why">Also suggested for you: {and(suggested)}</div>}
      {others.length > 0 && (
        <div className="why meta">
          with {and(others.slice(0, MAX_OTHERS_LISTED))}
          {others.length > MAX_OTHERS_LISTED && ` and ${others.length - MAX_OTHERS_LISTED} more`}
        </div>
      )}
      <div className="why">
        {show.url ? <a href={show.url}>{place || "Details"}</a> : place}
        <span className="meta"> · {Math.max(1, Math.round(show.miles))} mi</span>
      </div>
    </li>
  );
}

export default async function ConcertsPage({ searchParams }: PageProps<"/concerts">) {
  await connection(); // reads the database on every request, never at build time
  const withSuggested = (await searchParams).suggested === "1";
  const db = getDb();
  const now = new Date();
  const prefs = listPrefs(db, "liked");
  // Saving one band can merge two artist rows, so drop ids that merged away.
  const ids = transaction(db, () => artistIdsFor(db, prefs)).filter((id) => getArtistRow(db, id));
  const home = homeFromEnv();
  // Scores are those the Suggestions page last worked out.
  const suggested = withSuggested ? suggestionScores(db) : undefined;
  const shows = concertsFor(db, { liked: ids, suggested }, isoDay(now), home);
  const spotify = await spotifyLinks(db, shows.flatMap((s) => s.suggested.map((b) => b.name)));
  // The monthly pull of every concert around home is what finds most of these.
  after(() => refreshAreaIfDue(getDb()));

  const months: { month: string; shows: ConcertShow[] }[] = [];
  for (const s of shows) {
    const month = formatMonth(s.date);
    if (months.at(-1)?.month !== month) months.push({ month, shows: [] });
    months.at(-1)!.shows.push(s);
  }

  return (
    <>
      <h1>Concerts</h1>
      <p className="lede">
        Upcoming shows by bands you like{withSuggested && " and bands suggested for you"}, within{" "}
        {home.radiusMiles} miles of home, soonest first.
      </p>
      <p className="toggle-row">
        <Link
          href={withSuggested ? "/concerts" : "/concerts?suggested=1"}
          className="toggle"
          role="switch"
          aria-checked={withSuggested}
        >
          <span className="switch" aria-hidden="true" />
          Include suggested
        </Link>
      </p>

      {prefs.length === 0 && (
        <p className="notice">
          You haven&apos;t liked any bands yet. <Link href="/">Find some</Link> and their shows
          near you will show up here.
        </p>
      )}
      {prefs.length > 0 && shows.length === 0 && (
        <p className="notice">
          No upcoming shows near you are on record for your bands
          {withSuggested && " or your suggestions"}. Bands announce tours in batches, so check back
          later.
        </p>
      )}

      {months.map(({ month, shows }) => (
        <section key={month}>
          <h2 className="section-title">{month}</h2>
          <ol className="list">
            {shows.map((s) => (
              <Show key={s.eventId} show={s} listen={spotify.links} />
            ))}
          </ol>
        </section>
      ))}

      {shows.length > 0 && (
        <p className="meta" style={{ marginTop: "1.5rem" }}>
          {shows.length === 1 ? "1 show" : `${shows.length} shows`} from JamBase. Your bands&apos; own
          tour dates are checked a few at a time when you open Suggestions, and every concert
          around home is pulled once a month.
          {withSuggested &&
            " Suggested bands are the ones on your Suggestions list as of your last visit there, with the same match number; their names open on Spotify."}
        </p>
      )}
    </>
  );
}
