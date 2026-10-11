import Link from "next/link";
import { PrefButtons } from "./pref-buttons";
import { getDb } from "@/lib/db";
import { searchArtists, type ArtistCandidate } from "@/lib/musicbrainz";
import { countPrefs, getPref } from "@/lib/prefs";

function describe(c: ArtistCandidate): string {
  return [c.type, c.area ?? c.country, c.years, c.tags.join(", ")].filter(Boolean).join(" · ");
}

export default async function Home({ searchParams }: PageProps<"/">) {
  const params = await searchParams;
  const raw = params.q;
  const q = (Array.isArray(raw) ? raw[0] : raw)?.trim() ?? "";

  const db = getDb();
  const likedCount = countPrefs(db, "liked");

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
      <h1>Type the bands you love.</h1>
      <p className="lede">
        Like as many as you want. We&apos;ll find the artists sharing bills with them, and the
        artists one step further out: who your bands&apos; tourmates are playing with.
      </p>

      {likedCount > 0 && (
        <div className="picked">
          <Link href="/likes">
            Your {likedCount === 1 ? "band" : `${likedCount} bands`}
          </Link>
          <Link className="go" href="/bands">
            Find bands like {likedCount === 1 ? "this one" : `these ${likedCount}`} →
          </Link>
        </div>
      )}

      <form className="search" action="/" method="get">
        <input
          name="q"
          defaultValue={q}
          placeholder={likedCount ? "Add another band" : "e.g. Prince Daddy & The Hyena"}
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
              <li key={c.mbid} className="card">
                <div className="card-title">
                  {c.name}
                  {c.disambiguation && <span className="meta"> ({c.disambiguation})</span>}
                </div>
                <div className="meta">{describe(c)}</div>
                <PrefButtons
                  band={{ name: c.name, mbid: c.mbid }}
                  current={getPref(db, { name: c.name, mbid: c.mbid })}
                />
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}
