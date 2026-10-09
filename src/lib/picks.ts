/** The bands a user has picked travel in the URL as repeated `id=<mbid>` params. */
import { isMbid } from "./musicbrainz";

export const MAX_BANDS = 10;

/** Valid, distinct MusicBrainz IDs from a search param, at most MAX_BANDS. */
export function idsFrom(raw: string | string[] | undefined): string[] {
  const values = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
  const ids = values
    .flatMap((v) => v.split(","))
    .map((v) => v.trim().toLowerCase())
    .filter(isMbid);
  return [...new Set(ids)].slice(0, MAX_BANDS);
}

export function bandsHref(ids: string[]): string {
  return `/bands?${new URLSearchParams(ids.map((id) => ["id", id]))}`;
}
