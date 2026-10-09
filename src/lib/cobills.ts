import type { JbEvent, JbPerformer } from "./jambase";

/** How the recommended artist was billed relative to the seed band on one show. */
export type Relation =
  | "supports-seed" // the recommended artist opens for the seed band
  | "headlines-over-seed" // the seed band opens for the recommended artist
  | "shares-bill"; // co-headline, or no headliner flags

export type SharedShow = {
  eventId: string;
  date: string; // YYYY-MM-DD
  venue: string;
  city: string;
  url: string | null;
  relation: Relation;
  actsOnBill: number;
};

export type Recommendation = {
  jambaseId: string;
  name: string;
  url: string | null;
  score: number;
  shows: SharedShow[];
  /** The billing relation seen most often, used for the "why" text. */
  mainRelation: Relation;
};

export type CoBillResult = {
  recommendations: Recommendation[];
  /** Concerts kept after dropping festivals and cancelled shows. */
  concerts: number;
  /** Concerts that had at least one other act on the bill. */
  concertsWithOthers: number;
  festivalsSkipped: number;
};

const isCancelled = (e: JbEvent) =>
  /cancel|postpone/i.test(e.eventStatus ?? "");

/**
 * Work out which performer is the seed band. When we know its JamBase ID we
 * use it; otherwise it is the act that appears on the most of its own events,
 * with a name match breaking ties.
 */
export function findSeedId(events: JbEvent[], seedName: string, knownId?: string | null): string | null {
  if (knownId) return knownId;
  const counts = new Map<string, { n: number; name: string }>();
  for (const e of events) {
    for (const p of uniquePerformers(e)) {
      const c = counts.get(p.identifier) ?? { n: 0, name: p.name };
      c.n += 1;
      counts.set(p.identifier, c);
    }
  }
  let best: string | null = null;
  let bestN = -1;
  let bestNameMatch = false;
  const wanted = seedName.trim().toLowerCase();
  for (const [id, { n, name }] of counts) {
    const nameMatch = name.trim().toLowerCase() === wanted;
    if (n > bestN || (n === bestN && nameMatch && !bestNameMatch)) {
      best = id;
      bestN = n;
      bestNameMatch = nameMatch;
    }
  }
  return best;
}

function uniquePerformers(e: JbEvent): JbPerformer[] {
  const seen = new Set<string>();
  return (e.performer ?? []).filter((p) => {
    if (!p.identifier || seen.has(p.identifier)) return false;
    seen.add(p.identifier);
    return true;
  });
}

function relationOf(seed: JbPerformer, other: JbPerformer): Relation {
  const seedHead = seed["x-isHeadliner"] === true;
  const otherHead = other["x-isHeadliner"] === true;
  if (seedHead && !otherHead) return "supports-seed";
  if (otherHead && !seedHead) return "headlines-over-seed";
  return "shares-bill";
}

function place(e: JbEvent): { venue: string; city: string } {
  const loc = e.location ?? {};
  const a = loc.address ?? {};
  const region = a.addressRegion?.alternateName || a.addressRegion?.name;
  const country = a.addressCountry?.identifier;
  const cityParts = [a.addressLocality, region || (country !== "US" ? country : undefined)];
  return { venue: loc.name ?? "", city: cityParts.filter(Boolean).join(", ") };
}

/**
 * Rank the artists who share upcoming concert bills with the seed band.
 *
 * Each shared concert adds 1 / (acts on the bill − 1), so a three-act bill
 * counts for more than an eight-act one, and a run of tour dates together
 * adds up. Festivals are skipped entirely (decided 2026-10-09).
 */
export function scoreCoBills(
  events: JbEvent[],
  seedName: string,
  seedJambaseId?: string | null,
): CoBillResult {
  const seedId = findSeedId(events, seedName, seedJambaseId);
  const byArtist = new Map<string, Recommendation>();
  let concerts = 0;
  let concertsWithOthers = 0;
  let festivalsSkipped = 0;

  for (const e of events) {
    if (e["@type"] !== "Concert") {
      if (e["@type"] === "Festival") festivalsSkipped += 1;
      continue;
    }
    if (isCancelled(e)) continue;
    concerts += 1;

    const acts = uniquePerformers(e);
    const seed = acts.find((p) => p.identifier === seedId);
    const others = acts.filter((p) => p.identifier !== seedId);
    if (!seed || others.length === 0) continue;
    concertsWithOthers += 1;

    const weight = 1 / (acts.length - 1);
    const { venue, city } = place(e);
    for (const other of others) {
      const rec =
        byArtist.get(other.identifier) ??
        ({
          jambaseId: other.identifier,
          name: other.name,
          url: other.url ?? null,
          score: 0,
          shows: [],
          mainRelation: "shares-bill",
        } satisfies Recommendation);
      rec.score += weight;
      rec.shows.push({
        eventId: e.identifier,
        date: (e.startDate ?? "").slice(0, 10),
        venue,
        city,
        url: e.url ?? null,
        relation: relationOf(seed, other),
        actsOnBill: acts.length,
      });
      byArtist.set(other.identifier, rec);
    }
  }

  const recommendations = [...byArtist.values()];
  for (const rec of recommendations) {
    rec.shows.sort((a, b) => a.date.localeCompare(b.date));
    rec.mainRelation = mostCommon(rec.shows.map((s) => s.relation));
  }
  recommendations.sort(
    (a, b) =>
      b.score - a.score || b.shows.length - a.shows.length || a.name.localeCompare(b.name),
  );

  return { recommendations, concerts, concertsWithOthers, festivalsSkipped };
}

function mostCommon(relations: Relation[]): Relation {
  const order: Relation[] = ["supports-seed", "headlines-over-seed", "shares-bill"];
  let best: Relation = "shares-bill";
  let bestN = 0;
  for (const r of order) {
    const n = relations.filter((x) => x === r).length;
    if (n > bestN) {
      best = r;
      bestN = n;
    }
  }
  return best;
}

/** The one-line "why" for a recommendation, e.g. "Opening for Low on 6 dates". */
export function explain(rec: Recommendation, seedName: string): string {
  const n = rec.shows.filter((s) => s.relation === rec.mainRelation).length;
  const dates = n === 1 ? "1 date" : `${n} dates`;
  const extra = rec.shows.length - n;
  const more = extra > 0 ? `, plus ${extra} more shared ${extra === 1 ? "show" : "shows"}` : "";
  switch (rec.mainRelation) {
    case "supports-seed":
      return `Opening for ${seedName} on ${dates}${more}`;
    case "headlines-over-seed":
      return `${seedName} opens for them on ${dates}${more}`;
    default:
      return `Sharing the bill with ${seedName} on ${dates}${more}`;
  }
}
