import Link from "next/link";
import { notFound } from "next/navigation";
import { explain, type SharedShow } from "@/lib/cobills";
import { MissingJamBaseKeyError } from "@/lib/jambase";
import { getArtist } from "@/lib/musicbrainz";
import { recommendFor, type RecommendationOutcome } from "@/lib/recommend";

const MAX_SHOWS_LISTED = 3;

function formatDate(iso: string): string {
  const d = new Date(`${iso}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

function ShowLine({ show }: { show: SharedShow }) {
  const text = `${formatDate(show.date)} · ${[show.venue, show.city].filter(Boolean).join(", ")}`;
  return <li>{show.url ? <a href={show.url}>{text}</a> : text}</li>;
}

function TryAnother() {
  return (
    <p className="meta" style={{ marginTop: "1rem" }}>
      <Link href="/">Try another band</Link>, maybe one they&apos;ve toured with before.
    </p>
  );
}

function Empty({ name, outcome }: { name: string; outcome: RecommendationOutcome }) {
  let message: React.ReactNode;
  switch (outcome.kind) {
    case "not-on-jambase":
      message = (
        <>
          <strong>{name}</strong> isn&apos;t listed on JamBase, so we can&apos;t see their shows.
        </>
      );
      break;
    case "no-shows":
      message = (
        <>
          <strong>{name}</strong> has no upcoming concerts announced right now
          {outcome.festivalsSkipped > 0 &&
            ` (only festival dates, which we leave out because their lineups are too big to say much)`}
          . Bands announce tours in batches, so check back later.
        </>
      );
      break;
    case "no-cobills":
      message = (
        <>
          <strong>{name}</strong> has {outcome.result.concerts} upcoming{" "}
          {outcome.result.concerts === 1 ? "concert" : "concerts"}, but no other acts are
          announced on {outcome.result.concerts === 1 ? "it" : "them"} yet. Openers are often
          added closer to the date.
        </>
      );
      break;
    default:
      return null;
  }
  return (
    <>
      <p className="notice">{message}</p>
      <TryAnother />
    </>
  );
}

export default async function ArtistPage({ params }: PageProps<"/artist/[mbid]">) {
  const { mbid } = await params;
  const artist = await getArtist(mbid);
  if (!artist) notFound();

  let outcome: RecommendationOutcome;
  try {
    outcome = await recommendFor(artist);
  } catch (e) {
    if (e instanceof MissingJamBaseKeyError) {
      return (
        <p className="notice">
          This server has no JamBase key configured. Set <code>JAMBASE_API_KEY</code> in{" "}
          <code>.env.local</code> and restart.
        </p>
      );
    }
    throw e;
  }

  return (
    <>
      <h1>If you like {artist.name}</h1>
      <p className="lede">
        {artist.disambiguation || [artist.area, artist.years].filter(Boolean).join(", ")}
        {" · "}
        <a href={`https://musicbrainz.org/artist/${artist.mbid}`}>MusicBrainz</a>
      </p>

      {outcome.kind !== "ok" ? (
        <Empty name={artist.name} outcome={outcome} />
      ) : (
        <>
          <h2 className="section-title">
            Sharing upcoming bills with {artist.name}
          </h2>
          <ol className="list">
            {outcome.result.recommendations.map((rec) => (
              <li key={rec.jambaseId} className="card">
                <div className="card-title">
                  {rec.url ? <a href={rec.url}>{rec.name}</a> : rec.name}
                </div>
                <div className="why">{explain(rec, artist.name)}</div>
                <ul className="shows">
                  {rec.shows.slice(0, MAX_SHOWS_LISTED).map((s) => (
                    <ShowLine key={s.eventId} show={s} />
                  ))}
                  {rec.shows.length > MAX_SHOWS_LISTED && (
                    <li>and {rec.shows.length - MAX_SHOWS_LISTED} more</li>
                  )}
                </ul>
              </li>
            ))}
          </ol>
          <p className="meta" style={{ marginTop: "1rem" }}>
            From {outcome.result.concertsWithOthers} of {outcome.result.concerts} upcoming
            concerts that list other acts
            {outcome.result.festivalsSkipped > 0 &&
              `; ${outcome.result.festivalsSkipped} festival ${
                outcome.result.festivalsSkipped === 1 ? "date" : "dates"
              } left out`}
            .
          </p>
        </>
      )}
    </>
  );
}
