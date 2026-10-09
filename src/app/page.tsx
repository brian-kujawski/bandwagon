import Link from "next/link";
import { getArtist, searchArtists, type ArtistCandidate } from "@/lib/musicbrainz";
import { MAX_BANDS, bandsHref, idsFrom } from "@/lib/picks";

function describe(c: ArtistCandidate): string {
  return [c.type, c.area ?? c.country, c.years, c.tags.join(", ")].filter(Boolean).join(" · ");
}

async function nameOf(mbid: string): Promise<string> {
  try {
    return (await getArtist(mbid))?.name ?? "Unknown artist";
  } catch {
    return "Unknown artist";
  }
}

export default async function Home({ searchParams }: PageProps<"/">) {
  const params = await searchParams;
  const raw = params.q;
  const q = (Array.isArray(raw) ? raw[0] : raw)?.trim() ?? "";
  const picked = idsFrom(params.id);
  const pickedNames = await Promise.all(picked.map(nameOf));

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

  const full = picked.length >= MAX_BANDS;

  return (
    <>
      <h1>Type the bands you love.</h1>
      <p className="lede">
        Add one or several. We&apos;ll find the artists sharing bills with them, and the
        artists one step further out: who your bands&apos; tourmates are playing with.
      </p>

      {picked.length > 0 && (
        <div className="picked">
          <ul className="chips">
            {picked.map((id, i) => (
              <li key={id} className="chip">
                {pickedNames[i]}
                <Link
                  href={`/?${new URLSearchParams([
                    ...(q ? [["q", q]] : []),
                    ...picked.filter((p) => p !== id).map((p) => ["id", p]),
                  ])}`}
                  aria-label={`Remove ${pickedNames[i]}`}
                  className="chip-remove"
                >
                  ×
                </Link>
              </li>
            ))}
          </ul>
          <Link className="go" href={bandsHref(picked)}>
            Find bands like {picked.length === 1 ? "this one" : `these ${picked.length}`} →
          </Link>
        </div>
      )}

      <form className="search" action="/" method="get">
        {picked.map((id) => (
          <input key={id} type="hidden" name="id" value={id} />
        ))}
        <input
          name="q"
          defaultValue={q}
          placeholder={picked.length ? "Add another band" : "e.g. Prince Daddy & The Hyena"}
          aria-label="Band name"
          autoFocus
          disabled={full}
        />
        <button type="submit" disabled={full}>
          Search
        </button>
      </form>
      {full && <p className="meta">That&apos;s the most we take at once ({MAX_BANDS}).</p>}

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
            {candidates.map((c) => {
              const added = picked.includes(c.mbid);
              const title = (
                <>
                  <div className="card-title">
                    {c.name}
                    {c.disambiguation && <span className="meta"> ({c.disambiguation})</span>}
                    {added && <span className="meta"> · added</span>}
                  </div>
                  <div className="meta">{describe(c)}</div>
                </>
              );
              return (
                <li key={c.mbid}>
                  {added || full ? (
                    <div className="card">{title}</div>
                  ) : (
                    <Link
                      className="card"
                      href={`/?${new URLSearchParams([...picked, c.mbid].map((p) => ["id", p]))}`}
                    >
                      {title}
                    </Link>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </>
  );
}
