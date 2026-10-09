import { describe, expect, it } from "vitest";
import { escapeLucene, isMbid, toCandidate } from "./musicbrainz";

describe("toCandidate", () => {
  it("keeps what the disambiguation list shows", () => {
    const c = toCandidate({
      id: "a0e2c5d6-0000-4000-8000-000000000000",
      name: "Low",
      disambiguation: "US slowcore band",
      type: "Group",
      country: "US",
      area: { name: "United States" },
      "begin-area": { name: "Duluth" },
      "life-span": { begin: "1993", end: "2022-11-05", ended: true },
      tags: [
        { name: "indie rock", count: 3 },
        { name: "slowcore", count: 9 },
        { name: "dream pop", count: 5 },
        { name: "rock", count: 1 },
      ],
    });
    expect(c).toMatchObject({
      name: "Low",
      disambiguation: "US slowcore band",
      area: "United States",
      years: "1993–2022",
      tags: ["slowcore", "dream pop", "indie rock"],
    });
  });

  it("says present for active artists", () => {
    expect(toCandidate({ id: "x", name: "X", "life-span": { begin: "2015" } }).years).toBe(
      "2015–present",
    );
  });
});

describe("escapeLucene", () => {
  it("escapes query syntax in band names", () => {
    expect(escapeLucene("AC/DC")).toBe("AC\\/DC");
    expect(escapeLucene("!!!")).toBe("\\!\\!\\!");
    expect(escapeLucene("Prince Daddy & The Hyena")).toBe("Prince Daddy & The Hyena");
  });
});

describe("isMbid", () => {
  it("accepts UUIDs only", () => {
    expect(isMbid("c605445c-13ca-4cd2-bbc2-d5195004fe7f")).toBe(true);
    expect(isMbid("../etc")).toBe(false);
  });
});
