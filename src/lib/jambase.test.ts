import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getEventsNear, getUpcomingEvents, matchArtist, MissingJamBaseKeyError, type JbArtist } from "./jambase";

const MBID = "c605445c-13ca-4cd2-bbc2-d5195004fe7f";

const artist = (id: string, name: string, mbid?: string, upcoming = 3): JbArtist => ({
  identifier: `jambase:${id}`,
  name,
  "x-numUpcomingEvents": upcoming,
  sameAs: mbid ? [{ identifier: "musicbrainz", url: `https://musicbrainz.org/artist/${mbid}` }] : [],
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("matchArtist", () => {
  it("prefers the MusicBrainz link over the name", () => {
    const list = [artist("1", "Harrison Gordon"), artist("2", "Harrison Gordon", MBID)];
    expect(matchArtist(list, MBID, "Harrison Gordon")?.identifier).toBe("jambase:2");
  });

  it("accepts a single exact name match", () => {
    expect(matchArtist([artist("1", "Telescreens")], MBID, "telescreens")?.identifier).toBe(
      "jambase:1",
    );
  });

  it("refuses ambiguous names", () => {
    expect(matchArtist([artist("1", "Low"), artist("2", "Low")], MBID, "Low")).toBeNull();
  });
});

describe("getUpcomingEvents", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("JAMBASE_API_KEY", "test-key");
    vi.spyOn(console, "info").mockImplementation(() => {});
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("uses the MusicBrainz ID when JamBase accepts it", async () => {
    const id = "11111111-1111-4111-8111-111111111111";
    fetchMock.mockResolvedValueOnce(json({ events: [{ "@type": "Concert", identifier: "e1" }] }));
    const out = await getUpcomingEvents(id, "Band");
    expect(out.path).toBe("musicbrainz-id");
    expect(String(fetchMock.mock.calls[0][0])).toContain(`artistId=musicbrainz%3A${id}`);
    const headers = fetchMock.mock.calls[0][1]?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer test-key");
  });

  it("falls back to name search when the ID lookup is empty", async () => {
    const id = "22222222-2222-4222-8222-222222222222";
    fetchMock
      .mockResolvedValueOnce(json({ events: [] }))
      .mockResolvedValueOnce(json({ artists: [artist("7", "Band", id)] }))
      .mockResolvedValueOnce(json({ events: [{ "@type": "Concert", identifier: "e1" }] }));
    const out = await getUpcomingEvents(id, "Band");
    expect(out).toMatchObject({ path: "name-search", jambaseId: "jambase:7" });
    expect(out.events).toHaveLength(1);
    expect(String(fetchMock.mock.calls[2][0])).toContain("artistId=jambase%3A7");
  });

  it("reports artists JamBase doesn't have", async () => {
    const id = "33333333-3333-4333-8333-333333333333";
    fetchMock
      .mockResolvedValueOnce(json({ error: "bad id" }, 400))
      .mockResolvedValueOnce(json({ artists: [] }));
    expect((await getUpcomingEvents(id, "Nobody")).path).toBe("not-found");
  });

  it("does not hide auth errors", async () => {
    fetchMock.mockResolvedValueOnce(json({}, 401));
    await expect(
      getUpcomingEvents("44444444-4444-4444-8444-444444444444", "Band"),
    ).rejects.toThrow("HTTP 401");
  });

  it("needs a key", async () => {
    vi.stubEnv("JAMBASE_API_KEY", "");
    await expect(
      getUpcomingEvents("55555555-5555-4555-8555-555555555555", "Band"),
    ).rejects.toBeInstanceOf(MissingJamBaseKeyError);
  });

  it("asks for concerts within a radius, a page at a time", async () => {
    fetchMock.mockResolvedValueOnce(json({ events: [], pagination: { page: 2, totalPages: 4 } }));
    let calls = 0;
    const out = await getEventsNear({ lat: 42.3314, lon: -83.0458, radiusMiles: 100, from: "2026-10-10", page: 2 }, () => calls++);
    expect(out.pagination.totalPages).toBe(4);
    expect(calls).toBe(1);
    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      geoLatitude: "42.3314",
      geoLongitude: "-83.0458",
      geoRadiusAmount: "100",
      geoRadiusUnits: "mi",
      eventType: "concerts",
      eventDateFrom: "2026-10-10",
      page: "2",
      perPage: "100",
    });
  });
});
