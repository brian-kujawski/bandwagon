import { beforeEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "./db";
import { nameOfPlace, parseCoordinates, searchPlaces, shortLabel, type Fetcher } from "./geocode";

let db: Db;
beforeEach(() => {
  db = openDb(":memory:");
});

function fake(body: unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetcher: Fetcher = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status: 200 });
  };
  return { fetcher, calls };
}

describe("parseCoordinates", () => {
  it("reads lat,lon pairs and rejects the rest", () => {
    expect(parseCoordinates("42.33, -83.05")).toEqual({ lat: 42.33, lon: -83.05 });
    expect(parseCoordinates("42.33 -83.05")).toEqual({ lat: 42.33, lon: -83.05 });
    expect(parseCoordinates("Detroit")).toBeNull();
    expect(parseCoordinates("95, 10")).toBeNull();
  });
});

describe("searchPlaces", () => {
  it("never sends typed coordinates out", async () => {
    const { fetcher, calls } = fake([]);
    expect(await searchPlaces(db, "41.88,-87.63", fetcher)).toEqual([{ label: "41.88, -87.63", lat: 41.88, lon: -87.63 }]);
    expect(calls).toHaveLength(0);
  });

  it("asks Nominatim once with an identifying User-Agent, then uses the cache", async () => {
    const { fetcher, calls } = fake([
      { display_name: "Chicago, Cook County, Illinois, United States", lat: "41.8755", lon: "-87.6244" },
    ]);
    const first = await searchPlaces(db, "  Chicago ", fetcher);
    const again = await searchPlaces(db, "chicago", fetcher);
    expect(first).toEqual([{ label: "Chicago, Cook County, Illinois", lat: 41.8755, lon: -87.6244 }]);
    expect(again).toEqual(first);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("nominatim.openstreetmap.org/search?q=Chicago");
    expect((calls[0].init.headers as Record<string, string>)["User-Agent"]).toMatch(/^bandwagon\//);
  });

  it("names a spot from its coordinates", async () => {
    const { fetcher } = fake({ display_name: "Ann Arbor, Washtenaw County, Michigan, United States" });
    expect(await nameOfPlace(db, 42.2808, -83.743, fetcher)).toBe("Ann Arbor, Washtenaw County, Michigan");
  });
});

describe("shortLabel", () => {
  it("keeps the first three parts", () => {
    expect(shortLabel("A, B, C, D")).toBe("A, B, C");
  });
});
