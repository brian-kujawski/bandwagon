import Link from "next/link";
import { redirect } from "next/navigation";
import { describeBridge, describeDirect, type GraphCandidate, type LinkShow } from "@/lib/graph";
import { getArtist, type ArtistCandidate } from "@/lib/musicbrainz";
import { idsFrom } from "@/lib/picks";
import { recommendForMany, type SeedReport } from "@/lib/recommend";

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

function listNames(names: string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

function seedNote(r: SeedReport): string | null {
  const name = r.artist.name;
  switch (r.status.kind) {
    case "not-on-jambase":
      return r.storedShows
        ? `${name} isn't on JamBase; using ${r.storedShows} stored co-billed dates.`
        : `${name} isn't listed on JamBase, so we can't see their shows.`;
    case "unavailable":
      return r.status.reason === "no-key"
        ? null // said once for the whole page
        : `JamBase didn't answer for ${name}; using stored shows only.`;
    default:
      return r.storedShows === 0
        ? `${name} has no shared bills announced yet. Openers are often added closer to the date.`
        : null;
  }
}

function Candidate({ c, today }: { c: GraphCandidate; today: string }) {
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
    </li>
  );
}

export default async function BandsPage({ searchParams }: PageProps<"/bands">) {
  const ids = idsFrom((await searchParams).id);
  if (ids.length === 0) redirect("/");

  const found = await Promise.all(ids.map((id) => getArtist(id)));
  const artists = found.filter((a): a is ArtistCandidate => a !== null);
  if (artists.length === 0) redirect("/");

  const { seeds, graph, today } = await recommendForMany(artists);
  const noKey = seeds.some((s) => s.status.kind === "unavailable" && s.status.reason === "no-key");
  const notes = seeds.map(seedNote).filter((n): n is string => n !== null);
  const names = listNames(artists.map((a) => a.name));

  return (
    <>
      <h1>If you like {names}</h1>
      <p className="lede">
        <Link href={`/?${new URLSearchParams(ids.map((id) => ["id", id]))}`}>Add or remove bands</Link>
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
          <h2 className="section-title">Sharing bills with {artists.length > 1 ? "your bands" : names}</h2>
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
    </>
  );
}
