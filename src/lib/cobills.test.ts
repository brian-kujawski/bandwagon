import { describe, expect, it } from "vitest";
import { explain, findSeedId, scoreCoBills } from "./cobills";
import type { JbEvent, JbPerformer } from "./jambase";

const act = (id: string, name: string, headliner = false, rank = 1): JbPerformer => ({
  identifier: `jambase:${id}`,
  name,
  "x-isHeadliner": headliner,
  "x-performanceRank": rank,
});

const SEED = act("1", "Seed Band", true, 1);
const OPENER = act("2", "Opener", false, 2);
const SECOND = act("3", "Second Opener", false, 3);

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

describe("scoreCoBills", () => {
  it("ranks a tour support above a one-off big bill", () => {
    const events = [
      concert("1", "2026-11-01", [SEED, OPENER]),
      concert("2", "2026-11-02", [SEED, OPENER]),
      concert("3", "2026-11-03", [
        SEED,
        act("4", "A"),
        act("5", "B"),
        act("6", "C"),
        act("7", "D"),
      ]),
    ];
    const { recommendations, concerts, concertsWithOthers } = scoreCoBills(events, "Seed Band");
    expect(concerts).toBe(3);
    expect(concertsWithOthers).toBe(3);
    expect(recommendations[0].name).toBe("Opener");
    expect(recommendations[0].score).toBe(2);
    expect(recommendations[0].shows).toHaveLength(2);
    expect(recommendations[1].score).toBeCloseTo(0.25);
    expect(recommendations.map((r) => r.name)).not.toContain("Seed Band");
  });

  it("weights each show by 1 / (acts − 1)", () => {
    const { recommendations } = scoreCoBills(
      [concert("1", "2026-11-01", [SEED, OPENER, SECOND])],
      "Seed Band",
    );
    expect(recommendations.map((r) => r.score)).toEqual([0.5, 0.5]);
  });

  it("drops festivals and cancelled shows", () => {
    const fest: JbEvent = {
      ...concert("9", "2026-12-01", [SEED, OPENER, SECOND]),
      "@type": "Festival",
    };
    const cancelled = concert("8", "2026-12-02", [SEED, OPENER], { eventStatus: "cancelled" });
    const result = scoreCoBills([fest, cancelled], "Seed Band");
    expect(result.recommendations).toEqual([]);
    expect(result.concerts).toBe(0);
    expect(result.festivalsSkipped).toBe(1);
  });

  it("records who headlined", () => {
    const headliner = act("10", "Big Band", true, 1);
    const seedSupporting = act("1", "Seed Band", false, 2);
    const { recommendations } = scoreCoBills(
      [concert("1", "2026-11-01", [headliner, seedSupporting])],
      "Seed Band",
      "jambase:1",
    );
    expect(recommendations[0].mainRelation).toBe("headlines-over-seed");
    expect(explain(recommendations[0], "Seed Band")).toBe("Seed Band opens for them on 1 date");
  });

  it("counts concerts with no other acts", () => {
    const result = scoreCoBills([concert("1", "2026-11-01", [SEED])], "Seed Band", "jambase:1");
    expect(result.concerts).toBe(1);
    expect(result.concertsWithOthers).toBe(0);
    expect(result.recommendations).toEqual([]);
  });
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

describe("explain", () => {
  it("summarises the main relation and the rest", () => {
    const { recommendations } = scoreCoBills(
      [
        concert("1", "2026-11-01", [SEED, OPENER]),
        concert("2", "2026-11-02", [SEED, OPENER]),
        concert("3", "2026-11-03", [{ ...SEED, "x-isHeadliner": false }, OPENER]),
      ],
      "Seed Band",
    );
    expect(explain(recommendations[0], "Seed Band")).toBe(
      "Opening for Seed Band on 2 dates, plus 1 more shared show",
    );
  });
});
