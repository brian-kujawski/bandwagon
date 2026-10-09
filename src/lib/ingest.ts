/**
 * Write source data into the store (src/lib/db.ts). Festivals are left out
 * entirely (decided 2026-10-09): a 100-act lineup says little about two bands.
 */
import { findSeedId, isCancelled, place, uniquePerformers } from "./cobills.ts";
import { normName, type CaSummary } from "./concertArchives.ts";
import { recordFetch, saveEvent, transaction, upsertArtist, type Db } from "./db.ts";
import type { JbEvent } from "./jambase.ts";

export type IngestCounts = { concerts: number; festivalsSkipped: number; withOthers: number };

/**
 * Store one artist's JamBase events, and return the artist's row id.
 * `seed.mbid` is set when we came in from MusicBrainz; `seed.jambaseId` when
 * JamBase told us (name search, or a neighbour we expanded to).
 */
export function ingestJamBase(
  db: Db,
  events: JbEvent[],
  seed: { name: string; mbid?: string | null; jambaseId?: string | null },
  at: string = new Date().toISOString(),
): { artistId: number; counts: IngestCounts } {
  return transaction(db, () => {
    const counts: IngestCounts = { concerts: 0, festivalsSkipped: 0, withOthers: 0 };
    const seedJambaseId = findSeedId(events, seed.name, seed.jambaseId);
    const artistId = upsertArtist(db, {
      name: seed.name,
      mbid: seed.mbid,
      jambaseId: seedJambaseId,
    });

    for (const e of events) {
      if (e["@type"] !== "Concert") {
        if (e["@type"] === "Festival") counts.festivalsSkipped += 1;
        continue;
      }
      const performers = uniquePerformers(e);
      const acts = performers.map((p) => ({
        artistId:
          p.identifier === seedJambaseId
            ? artistId
            : upsertArtist(db, { name: p.name, jambaseId: p.identifier, url: p.url }),
        headliner: typeof p["x-isHeadliner"] === "boolean" ? p["x-isHeadliner"] : null,
        billingRank: p["x-performanceRank"] ?? null,
      }));
      const cancelled = isCancelled(e);
      if (!cancelled) {
        counts.concerts += 1;
        if (acts.length > 1) counts.withOthers += 1;
      }
      saveEvent(
        db,
        {
          source: "jambase",
          sourceId: e.identifier,
          date: e.startDate?.slice(0, 10) ?? null,
          ...place(e),
          url: e.url ?? null,
          cancelled,
          acts,
        },
        at,
      );
    }
    recordFetch(db, artistId, "jambase", at);
    return { artistId, counts };
  });
}

/**
 * Store a Concert Archives summary (from scripts/concert-archives.mts). Only
 * shows whose title spells out a lineup of two or more acts carry a co-bill.
 * Concert Archives names acts but gives no IDs, so they link to other sources
 * by name (see upsertArtist).
 */
export function ingestConcertArchives(
  db: Db,
  summary: CaSummary,
  slug: string,
  at: string = new Date().toISOString(),
): { artistId: number; shows: number } {
  return transaction(db, () => {
    const artistId = upsertArtist(db, { name: summary.seed, caSlug: slug });
    let shows = 0;
    for (const s of summary.shows) {
      if (s.festival || !s.lineup || s.lineup.length < 2) continue;
      shows += 1;
      saveEvent(
        db,
        {
          source: "concertarchives",
          sourceId: s.slug,
          date: s.date,
          venue: s.venue,
          city: "",
          url: `https://www.concertarchives.org/concerts/${s.slug}`,
          cancelled: false,
          // Titles usually list the headliner first, but not reliably enough to say so.
          acts: s.lineup.map((name, i) => ({
            artistId: normName(name) === normName(summary.seed) ? artistId : upsertArtist(db, { name }),
            headliner: null,
            billingRank: i + 1,
          })),
        },
        at,
      );
    }
    recordFetch(db, artistId, "concertarchives", at);
    return { artistId, shows };
  });
}
