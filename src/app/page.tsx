import Link from "next/link";
import { setBandPref } from "./actions";
import { PrefButtons } from "./pref-buttons";
import { getDb } from "@/lib/db";
import { searchArtists, type ArtistCandidate } from "@/lib/musicbrainz";
import { countPrefs, getPref, listPrefs, type BandPref } from "@/lib/prefs";

/** How many saved bands each list shows before "and N more". */
const SHOWN = 100;

function describe(c: ArtistCandidate): string {
  return [c.type, c.area ?? c.country, c.years, c.tags.join(", ")].filter(Boolean).join(" · ");
}

function SavedChips({ prefs, total }: { prefs: BandPref[]; total: number }) {
  return (
    <ul className="chips">
      {prefs.map((p) => (
        <li key={p.key} className="chip">
          {p.name}
          <form action={setBandPref}>
            <input type="hidden" name="name" value={p.name} />
            {p.mbid && <input type="hidden" name="mbid" value={p.mbid} />}
            <button
              type="submit"
              name="status"
              value="cleared"
              className="chip-remove"
              aria-label={`Remove ${p.name}`}
            >
              ×
            </button>
          </form>
        </li>
      ))}
      {total > prefs.length && <li className="meta">and {total - prefs.length} more</li>}
    </ul>
  );
}

export default async function Home({ searchParams }: PageProps<"/">) {
  const params = await searchParams;
  const raw = params.q;
  const q = (Array.isArray(raw) ? raw[0] : raw)?.trim() ?? "";

  const db = getDb();
  const likedCount = countPrefs(db, "liked");
  const liked = listPrefs(db, "liked", { limit: SHOWN });
  const hiddenCount = countPrefs(db, "not_interested");
  const hidden = listPrefs(db, "not_interested", { limit: SHOWN });

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
          <SavedChips prefs={liked} total={likedCount} />
          <Link className="go" href="/bands">
            Find bands like {likedCount === 1 ? "this one" : `these ${likedCount}`} →
          </Link>
        </div>
      )}

      {hiddenCount > 0 && (
        <details className="saved">
          <summary>Not interested ({hiddenCount})</summary>
          <SavedChips prefs={hidden} total={hiddenCount} />
        </details>
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
