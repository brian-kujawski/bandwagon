/**
 * Turns Concert Archives concert lists (fetched through the parse.bot
 * "concertarchives.org API") into co-bill data. Pure functions only; the
 * fetching lives in scripts/concert-archives.mts.
 *
 * A performer's concert list gives date, title, venue and slug per row. For
 * club shows the title is the lineup ("PUP / NoBro / PONY"), so the list alone
 * is enough to find co-bills without paying for a details call per concert.
 */

/** One row of get_performer_concerts. */
export type CaConcertRow = {
  date: string; // "Oct 29, 2026" or "Oct 23, 2026 –Oct 25, 2026"
  title: string;
  slug: string;
  venue: string;
};

export type CaShow = {
  slug: string;
  date: string | null; // YYYY-MM-DD, first day for multi-day rows
  venue: string;
  title: string;
  /** Acts on the bill, or null when the title doesn't spell out a lineup. */
  lineup: string[] | null;
  festival: boolean;
};

export type CaCoBill = {
  name: string;
  shows: { date: string | null; venue: string; slug: string }[];
};

export type CaSummary = {
  seed: string;
  rows: number;
  duplicates: number;
  festivalsSkipped: number;
  /** Non-festival shows whose title names no lineup (e.g. just "PUP"). */
  noLineup: number;
  shows: CaShow[];
  coBills: CaCoBill[];
};

const MONTHS: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

/** "Oct 29, 2026" -> "2026-10-29"; uses the first date of a range. */
export function parseCaDate(raw: string): string | null {
  const m = raw.match(/([A-Za-z]{3})[a-z]*\.? (\d{1,2}), (\d{4})/);
  if (!m) return null;
  const month = MONTHS[m[1].toLowerCase()];
  return month ? `${m[3]}-${month}-${m[2].padStart(2, "0")}` : null;
}

const norm = (s: string) =>
  s.trim().toLowerCase().replace(/\s+&\s+/g, " and ").replace(/\s+/g, " ");

/** The lineup a title spells out, or null when it is an event name. */
export function lineupFromTitle(title: string, seed: string): string[] | null {
  const t = title.trim();
  if (t.includes(" / ")) {
    const acts = t
      .split(" / ")
      .map((a) => a.trim())
      .filter((a) => a && a !== "..." && !a.endsWith("..."));
    return [...new Map(acts.map((a) => [norm(a), a])).values()];
  }
  return norm(t) === norm(seed) ? [t] : null;
}

const FESTIVAL_WORDS = /\bfest(ival)?s?\b|2000 ?trees/i;
const MAX_CLUB_BILL = 6;

export function isFestivalRow(row: CaConcertRow, lineup: string[] | null): boolean {
  if (/[–—]/.test(row.date)) return true; // multi-day
  // The slug catches festival sets titled as a plain lineup ("2000trees-festival--1445...").
  if ([row.title, row.venue, row.slug].some((f) => FESTIVAL_WORDS.test(f))) return true;
  if (/\.\.\.\s*$/.test(row.title)) return true; // truncated mega-bill
  return lineup !== null && lineup.length > MAX_CLUB_BILL;
}

/**
 * Normalise, de-duplicate and tally a performer's concert rows. Concert
 * Archives often has the same show entered several times by different users,
 * so rows collapse on date plus lineup (or title when there is no lineup).
 */
export function summariseConcerts(rows: CaConcertRow[], seed: string): CaSummary {
  const seen = new Set<string>();
  const shows: CaShow[] = [];
  let duplicates = 0;
  let festivalsSkipped = 0;
  let noLineup = 0;

  for (const row of rows) {
    const lineup = lineupFromTitle(row.title, seed);
    const date = parseCaDate(row.date);
    const key = `${date ?? row.date}|${lineup ? lineup.map(norm).sort().join("+") : norm(row.title)}`;
    if (seen.has(key)) {
      duplicates += 1;
      continue;
    }
    seen.add(key);
    const festival = isFestivalRow(row, lineup);
    shows.push({ slug: row.slug, date, venue: row.venue, title: row.title, lineup, festival });
    if (festival) festivalsSkipped += 1;
    else if (!lineup || lineup.length < 2) noLineup += 1;
  }

  const byAct = new Map<string, CaCoBill>();
  for (const s of shows) {
    if (s.festival || !s.lineup) continue;
    for (const act of s.lineup) {
      if (norm(act) === norm(seed)) continue;
      const entry = byAct.get(norm(act)) ?? { name: act, shows: [] };
      entry.shows.push({ date: s.date, venue: s.venue, slug: s.slug });
      byAct.set(norm(act), entry);
    }
  }
  const coBills = [...byAct.values()].sort(
    (a, b) => b.shows.length - a.shows.length || a.name.localeCompare(b.name),
  );

  return { seed, rows: rows.length, duplicates, festivalsSkipped, noLineup, shows, coBills };
}
