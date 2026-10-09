import { describe, expect, it } from "vitest";
import { isFestivalRow, lineupFromTitle, parseCaDate, summariseConcerts, type CaConcertRow } from "./concertArchives";

// Rows copied from a real get_performer_concerts page for PUP (2026-10-09).
const row = (date: string, title: string, venue: string, slug: string): CaConcertRow => ({ date, title, venue, slug });
const ROWS: CaConcertRow[] = [
  row("Oct 29, 2026", "PUP / NoBro / PONY", "Eastside Bowl", "pup-pony-190d"),
  row("Oct 29, 2026", "PUP / NoBro / PONY", "Eastside Bowl", "the-dream-is-over"),
  row("Oct 28, 2026", "PUP / NoBro / PONY", "Mercury Ballroom", "pup-nobro-pony-4493"),
  row("Oct 19, 2026", "PUP / PONY / NoBro", "The Queen Theater", "pup-pony-nobro-846b"),
  row("Oct 24, 2026", "Bo Diddley Plaza: Lagwagon, Pup, Bouncing Souls 2026", "Bo Diddley Plaza", "bo-diddley"),
  row("Oct 23, 2026 –Oct 25, 2026", "The FEST 24 2026", "Multiple Venues", "the-fest-24-2026"),
  row("Oct 23, 2026 –Oct 24, 2026", "PUP", "FEST 2026", "fest-2026"),
  row("Oct 12, 2026", "PUP", "Under the Neon Palms at the El Mocambo", "give-thanks-go-long"),
  row("Oct 04, 2026", "Neverender Festival", "The Observatory", "neverender"),
  row("Sep 18, 2026", "PUP / Destroy Boys", "Metro", "riot-fest-late-night"),
  row("Aug 23, 2026", "Jimmy Eat World / PUP / Ratboys / DJ Kage", "RBC Amphitheatre, Ontario Place", "pup-jimmy-eat-world"),
  row("Jul 09, 2026", "Superheaven / PUP / Thursday / Bad Nerves / The Bronx", "Upcote Farm", "2000trees-festival"),
  row("Jul 08, 2026", "2000 Trees Festival Day 1", "Upcote Farm", "2000-trees-day-1"),
];

describe("parseCaDate", () => {
  it("parses single dates and the first day of ranges", () => {
    expect(parseCaDate("Oct 29, 2026")).toBe("2026-10-29");
    expect(parseCaDate("Jul 08, 2026 –Jul 11, 2026")).toBe("2026-07-08");
    expect(parseCaDate("Wednesday, October 28, 2026")).toBe("2026-10-28");
    expect(parseCaDate("TBA")).toBeNull();
  });
});

describe("lineupFromTitle", () => {
  it("splits slash-separated lineups and drops truncation", () => {
    expect(lineupFromTitle("PUP / NoBro / PONY", "PUP")).toEqual(["PUP", "NoBro", "PONY"]);
    expect(lineupFromTitle("A / B / ...", "A")).toEqual(["A", "B"]);
  });

  it("treats a bare seed name as a lineup of one and event names as unknown", () => {
    expect(lineupFromTitle("PUP", "pup")).toEqual(["PUP"]);
    expect(lineupFromTitle("Neverender Festival", "PUP")).toBeNull();
  });
});

describe("isFestivalRow", () => {
  it("flags multi-day rows, festival names and venues", () => {
    expect(isFestivalRow(ROWS[5], null)).toBe(true);
    expect(isFestivalRow(ROWS[6], ["PUP"])).toBe(true);
    expect(isFestivalRow(ROWS[12], null)).toBe(true);
    expect(isFestivalRow(ROWS[2], ["PUP", "NoBro", "PONY"])).toBe(false);
  });
});

describe("summariseConcerts", () => {
  const s = summariseConcerts(ROWS, "PUP");

  it("collapses duplicate entries of the same show", () => {
    expect(s.duplicates).toBe(1);
  });

  it("tallies co-billed acts, skipping festivals and the seed itself", () => {
    const names = s.coBills.map((c) => c.name);
    expect(names.slice(0, 2).sort()).toEqual(["NoBro", "PONY"]);
    expect(s.coBills.find((c) => c.name === "NoBro")?.shows).toHaveLength(3);
    expect(names).not.toContain("Destroy Boys"); // Riot Fest aftershow, by its slug
    expect(names).toContain("Jimmy Eat World");
    expect(names).not.toContain("PUP");
    expect(names).not.toContain("Superheaven"); // 2000 Trees, a festival
  });

  it("merges spellings that differ only by & and and", () => {
    const merged = summariseConcerts(
      [row("Jul 04, 2026", "PUP / Gen & The Degenerates", "A", "a"), row("Jul 05, 2026", "PUP / Gen And The Degenerates", "B", "b")],
      "PUP",
    );
    expect(merged.coBills).toHaveLength(1);
    expect(merged.coBills[0].shows).toHaveLength(2);
  });

  it("counts shows without a usable lineup", () => {
    // "Bo Diddley Plaza: ..." and the bare "PUP" at El Mocambo
    expect(s.noLineup).toBe(2);
  });
});
