import { scoreCoBills, type CoBillResult } from "./cobills";
import { getUpcomingEvents } from "./jambase";
import type { ArtistCandidate } from "./musicbrainz";

export type RecommendationOutcome =
  /** JamBase has no artist matching this MusicBrainz artist. */
  | { kind: "not-on-jambase" }
  /** JamBase knows the artist, but no upcoming concerts are announced. */
  | { kind: "no-shows"; festivalsSkipped: number }
  /** Concerts are announced, but none lists another act yet. */
  | { kind: "no-cobills"; result: CoBillResult }
  | { kind: "ok"; result: CoBillResult };

export async function recommendFor(artist: ArtistCandidate): Promise<RecommendationOutcome> {
  const upcoming = await getUpcomingEvents(artist.mbid, artist.name);
  if (upcoming.path === "not-found") return { kind: "not-on-jambase" };

  const result = scoreCoBills(upcoming.events, artist.name, upcoming.jambaseId);
  if (result.concerts === 0) {
    return { kind: "no-shows", festivalsSkipped: result.festivalsSkipped };
  }
  if (result.recommendations.length === 0) return { kind: "no-cobills", result };
  return { kind: "ok", result };
}
