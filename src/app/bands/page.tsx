import Link from "next/link";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { PrefButtons } from "../pref-buttons";
import { getDb } from "@/lib/db";
import { describeBridge, describeDirect, type GraphCandidate, type LinkShow } from "@/lib/graph";
import { recommendForProfile, type ProfileOutcome } from "@/lib/recommend";

const MAX_SHOWS_LISTED = 3;
const MAX_BRIDGES_LISTED = 2;

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

function Candidate({ c, today }: { c: GraphCandidate; today: string }) {
  const band = { name: c.artist.name, mbid: c.artist.mbid, jambaseId: c.artist.jambase_id, caSlug: c.artist.ca_slug };
  const name = c.artist.url ? <a href={c.artist.url}>{c.artist.name}</a> : c.artist.name;
  const shows = c.direct.flatMap((d) => d.shows);
  return (
    <li className="card">
      <div className="card-title">{name}</div>
      {c.direct.map((d) => (
        <div key={d.seed.id} className="why">
          {describeDirect(d, today)}
        </div>
      ))}
      {c.direct.length === 0 &&
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
      {c.direct.length === 0 && c.bridges.length > MAX_BRIDGES_LISTED && (
        <p className="meta">and {c.bridges.length - MAX_BRIDGES_LISTED} more links like these</p>
      )}
      <PrefButtons band={band} current={null} />
    </li>
  );
}

export default async function BandsPage() {
  await connection(); // reads the database on every request, never at build time
  const outcome = await recommendForProfile(getDb());
  if (outcome.liked === 0) redirect("/");
  const { graph, today, noKey, budget } = outcome;
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

      {graph.direct.length === 0 && graph.oneStep.length === 0 && (
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

      {graph.direct.length > 0 && (
        <>
          <h2 className="section-title">Sharing bills with your bands</h2>
          <ol className="list">
            {graph.direct.map((c) => (
              <Candidate key={c.artist.id} c={c} today={today} />
            ))}
          </ol>
        </>
      )}

      {graph.oneStep.length > 0 && (
        <>
          <h2 className="section-title">One step further</h2>
          <p className="meta" style={{ marginBottom: "0.75rem" }}>
            Sharing bills, on other dates, with the acts your bands play with.
          </p>
          <ol className="list">
            {graph.oneStep.map((c) => (
              <Candidate key={c.artist.id} c={c} today={today} />
            ))}
          </ol>
        </>
      )}

      {(graph.direct.length > 0 || graph.oneStep.length > 0) && (
        <p className="meta" style={{ marginTop: "1.5rem" }}>
          From upcoming concerts on JamBase plus any history stored locally. Festivals are left
          out.
        </p>
      )}
      <p className="meta" style={{ marginTop: "0.5rem" }}>
        {outcome.waiting > 0 &&
          `${outcome.waiting} of your bands are due a JamBase check; a few get one each visit. `}
        JamBase calls this month: {budget.used} of {budget.limit}.
      </p>
    </>
  );
}
