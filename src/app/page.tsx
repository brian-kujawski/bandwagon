import Link from "next/link";
import { searchArtists, type ArtistCandidate } from "@/lib/musicbrainz";

function describe(c: ArtistCandidate): string {
  return [c.type, c.area ?? c.country, c.years, c.tags.join(", ")].filter(Boolean).join(" · ");
}

export default async function Home({ searchParams }: PageProps<"/">) {
  const raw = (await searchParams).q;
  const q = (Array.isArray(raw) ? raw[0] : raw)?.trim() ?? "";

  let candidates: ArtistCandidate[] = [];
  let failed = false;
  if (q) {
    try {
      candidates = await searchArtists(q);
    } catch (e) {
      console.error(e);
      failed = true;
    }
  }

  return (
    <>
      <h1>Type a band you love.</h1>
      <p className="lede">
        We&apos;ll find the artists sharing upcoming bills with them: their openers, the
        bands they open for, and their tourmates.
      </p>

      <form className="search" action="/" method="get">
        <input
          name="q"
          defaultValue={q}
          placeholder="e.g. Prince Daddy & The Hyena"
          aria-label="Band name"
          autoFocus
        />
        <button type="submit">Search</button>
      </form>

      {failed && (
        <p className="notice">MusicBrainz didn&apos;t answer just now. Try again in a moment.</p>
      )}

      {q && !failed && candidates.length === 0 && (
        <p className="notice">
          No artists called <strong>{q}</strong> on MusicBrainz. Check the spelling?
        </p>
      )}

      {candidates.length > 0 && (
        <>
          <h2 className="section-title">Which one do you mean?</h2>
          <ul className="list">
            {candidates.map((c) => (
              <li key={c.mbid}>
                <Link className="card" href={`/artist/${c.mbid}`}>
                  <div className="card-title">
                    {c.name}
                    {c.disambiguation && (
                      <span className="meta"> ({c.disambiguation})</span>
                    )}
                  </div>
                  <div className="meta">{describe(c)}</div>
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}
