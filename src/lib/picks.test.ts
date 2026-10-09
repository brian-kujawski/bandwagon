import { describe, expect, it } from "vitest";
import { MAX_BANDS, bandsHref, idsFrom } from "./picks";

const id = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;

describe("idsFrom", () => {
  it("keeps valid, distinct MusicBrainz IDs", () => {
    expect(idsFrom([id(1), "nope", id(1).toUpperCase(), id(2)])).toEqual([id(1), id(2)]);
    expect(idsFrom(`${id(1)},${id(2)}`)).toEqual([id(1), id(2)]);
    expect(idsFrom(undefined)).toEqual([]);
  });

  it("caps the number of bands", () => {
    const many = Array.from({ length: MAX_BANDS + 3 }, (_, i) => id(i));
    expect(idsFrom(many)).toHaveLength(MAX_BANDS);
  });
});

it("bandsHref repeats the id param", () => {
  expect(bandsHref([id(1), id(2)])).toBe(`/bands?id=${id(1)}&id=${id(2)}`);
});
