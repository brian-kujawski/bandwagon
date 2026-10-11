import Link from "next/link";
import { after, connection } from "next/server";
import { getArtistRow, getDb, transaction } from "@/lib/db";
import { homeFromEnv, likedShows, type LikedShow } from "@/lib/nearby";
import { artistIdsFor, listPrefs } from "@/lib/prefs";
import { refreshAreaIfDue } from "@/lib/recommend";

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
const and = (names: string[]) =>
  names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;

function Show({ show }: { show: LikedShow }) {
  const liked = new Set(show.liked);
  const others = show.lineup.filter((n) => !liked.has(n));
  const place = [show.venue, show.city].filter(Boolean).join(", ");
  return (
    <li className="card">
      <div className="card-head">
        <div className="card-title">{and(show.liked)}</div>
        <span className="meta">{formatDay(show.date)}</span>
      </div>
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

export default async function ConcertsPage() {
  await connection(); // reads the database on every request, never at build time
  const db = getDb();
  const now = new Date();
  const prefs = listPrefs(db, "liked");
  // Saving one band can merge two artist rows, so drop ids that merged away.
  const ids = transaction(db, () => artistIdsFor(db, prefs)).filter((id) => getArtistRow(db, id));
  const home = homeFromEnv();
  const shows = likedShows(db, ids, isoDay(now), home);
  // The monthly pull of every concert around home is what finds most of these.
  after(() => refreshAreaIfDue(getDb()));

  const months: { month: string; shows: LikedShow[] }[] = [];
  for (const s of shows) {
    const month = formatMonth(s.date);
    if (months.at(-1)?.month !== month) months.push({ month, shows: [] });
    months.at(-1)!.shows.push(s);
  }

  return (
    <>
      <h1>Concerts</h1>
      <p className="lede">
        Upcoming shows by bands you like, within {home.radiusMiles} miles of home, soonest first.
      </p>

      {prefs.length === 0 && (
        <p className="notice">
          You haven&apos;t liked any bands yet. <Link href="/">Find some</Link> and their shows
          near you will show up here.
        </p>
      )}
      {prefs.length > 0 && shows.length === 0 && (
        <p className="notice">
          No upcoming shows near you are on record for your bands. Bands announce tours in
          batches, so check back later.
        </p>
      )}

      {months.map(({ month, shows }) => (
        <section key={month}>
          <h2 className="section-title">{month}</h2>
          <ol className="list">
            {shows.map((s) => (
              <Show key={s.eventId} show={s} />
            ))}
          </ol>
        </section>
      ))}

      {shows.length > 0 && (
        <p className="meta" style={{ marginTop: "1.5rem" }}>
          {shows.length === 1 ? "1 show" : `${shows.length} shows`} from JamBase. Your bands&apos; own
          tour dates are checked a few at a time when you open Suggestions, and every concert
          around home is pulled once a month.
        </p>
      )}
    </>
  );
}
