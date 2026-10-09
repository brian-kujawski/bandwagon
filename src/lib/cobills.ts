import type { JbEvent, JbPerformer } from "./jambase.ts";

/** How a linked artist was billed relative to one of the user's bands on one show. */
export type Relation =
  | "supports-seed" // the linked artist opens for the user's band
  | "headlines-over-seed" // the user's band opens for the linked artist
  | "shares-bill"; // co-headline, or no headliner flags

export const isCancelled = (e: JbEvent) => /cancel|postpone/i.test(e.eventStatus ?? "");

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

export function uniquePerformers(e: JbEvent): JbPerformer[] {
  const seen = new Set<string>();
  return (e.performer ?? []).filter((p) => {
    if (!p.identifier || seen.has(p.identifier)) return false;
    seen.add(p.identifier);
    return true;
  });
}

/** Headliner flags are null when the source doesn't say (Concert Archives). */
export function relationOf(seedHeadlines: boolean | null, otherHeadlines: boolean | null): Relation {
  if (seedHeadlines === true && otherHeadlines !== true) return "supports-seed";
  if (otherHeadlines === true && seedHeadlines !== true) return "headlines-over-seed";
  return "shares-bill";
}

export function place(e: JbEvent): { venue: string; city: string } {
  const loc = e.location ?? {};
  const a = loc.address ?? {};
  const region = a.addressRegion?.alternateName || a.addressRegion?.name;
  const country = a.addressCountry?.identifier;
  const cityParts = [a.addressLocality, region || (country !== "US" ? country : undefined)];
  return { venue: loc.name ?? "", city: cityParts.filter(Boolean).join(", ") };
}

export function mostCommon(relations: Relation[]): Relation {
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
