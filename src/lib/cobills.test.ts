import { describe, expect, it } from "vitest";
import { findSeedId, relationOf } from "./cobills";
import type { JbEvent, JbPerformer } from "./jambase";

const act = (id: string, name: string, headliner = false, rank = 1): JbPerformer => ({
  identifier: `jambase:${id}`,
  name,
  "x-isHeadliner": headliner,
  "x-performanceRank": rank,
});

const SEED = act("1", "Seed Band", true, 1);
const OPENER = act("2", "Opener", false, 2);

const concert = (id: string, date: string, performer: JbPerformer[], extra: Partial<JbEvent> = {}): JbEvent => ({
  "@type": "Concert",
  identifier: `jambase:e${id}`,
  startDate: `${date}T20:00:00`,
  url: `https://www.jambase.com/show/${id}`,
  location: {
    name: `Venue ${id}`,
    address: { addressLocality: "Minneapolis", addressRegion: { alternateName: "MN" } },
  },
  performer,
  ...extra,
});

describe("findSeedId", () => {
  it("picks the act on the most events", () => {
    const events = [
      concert("1", "2026-11-01", [SEED, OPENER]),
      concert("2", "2026-11-02", [SEED]),
    ];
    expect(findSeedId(events, "whatever")).toBe("jambase:1");
  });

  it("breaks ties with the name", () => {
    expect(findSeedId([concert("1", "2026-11-01", [OPENER, SEED])], "seed band")).toBe("jambase:1");
  });
});

describe("relationOf", () => {
  it("reads headliner flags, and treats unknown as a shared bill", () => {
    expect(relationOf(true, false)).toBe("supports-seed");
    expect(relationOf(false, true)).toBe("headlines-over-seed");
    expect(relationOf(true, true)).toBe("shares-bill");
    expect(relationOf(null, null)).toBe("shares-bill");
  });
});
