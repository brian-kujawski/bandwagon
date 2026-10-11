import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDb } from "./db";
import { matchSpotifyArtist, resetSpotifyToken, spotifyLinks } from "./spotify";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const search = (...items: [string, string][]) => json({ artists: { items: items.map(([id, name]) => ({ id, name })) } });
const tokenOk = () => json({ access_token: "tok", token_type: "Bearer", expires_in: 3600 });

describe("matchSpotifyArtist", () => {
  it("takes the single exact name match, ignoring case, accents and a leading The", () => {
    expect(matchSpotifyArtist([{ id: "1", name: "Mötley Crüe" }], "motley crue")?.id).toBe("1");
    expect(matchSpotifyArtist([{ id: "1", name: "The Beths" }, { id: "2", name: "Beth" }], "Beths")?.id).toBe("1");
  });

  it("takes the most relevant of several same-named artists, and refuses near misses", () => {
    expect(matchSpotifyArtist([{ id: "x", name: "Lowly" }, { id: "1", name: "Low" }, { id: "2", name: "LOW" }], "Low")?.id).toBe("1");
    expect(matchSpotifyArtist([{ id: "1", name: "Pup Tent" }], "PUP")).toBeNull();
  });
});

describe("spotifyLinks", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("SPOTIFY_CLIENT_ID", "id");
    vi.stubEnv("SPOTIFY_CLIENT_SECRET", "secret");
    vi.spyOn(console, "error").mockImplementation(() => {});
    fetchMock.mockReset();
    resetSpotifyToken();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("links the artist page, falls back to search, and looks each band up once", async () => {
    const db = openDb(":memory:");
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.startsWith("https://accounts.spotify.com")) return tokenOk();
      const q = new URL(url).searchParams.get("q");
      return q === "PUP" ? search(["x", "Pup Tent"], ["pup1", "PUP"]) : search(["a", "Lowly"]);
    });

    const { links, problem } = await spotifyLinks(db, ["PUP", "Low"]);
    expect(problem).toBeNull();
    expect(links.get("PUP")).toBe("https://open.spotify.com/artist/pup1");
    expect(links.get("Low")).toBe("https://open.spotify.com/search/Low");
    expect(fetchMock).toHaveBeenCalledTimes(3); // one token, two searches

    const [, init] = fetchMock.mock.calls.find(([u]) => String(u).startsWith("https://accounts"))!;
    expect((init?.headers as Record<string, string>).Authorization).toBe(
      `Basic ${Buffer.from("id:secret").toString("base64")}`,
    );

    fetchMock.mockClear();
    const again = await spotifyLinks(db, ["PUP", "Low"]);
    expect(again.links.get("PUP")).toBe("https://open.spotify.com/artist/pup1");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("retries a band with no match after a month", async () => {
    const db = openDb(":memory:");
    fetchMock.mockImplementation(async (input) =>
      String(input).startsWith("https://accounts") ? tokenOk() : search(),
    );
    await spotifyLinks(db, ["Nobody Yet"], new Date("2026-10-01T00:00:00Z"));
    fetchMock.mockClear();
    await spotifyLinks(db, ["Nobody Yet"], new Date("2026-10-15T00:00:00Z"));
    expect(fetchMock).not.toHaveBeenCalled();
    await spotifyLinks(db, ["Nobody Yet"], new Date("2026-11-15T00:00:00Z"));
    expect(fetchMock).toHaveBeenCalled();
  });

  it("uses search links without credentials or when Spotify fails, and stores nothing", async () => {
    const db = openDb(":memory:");
    vi.stubEnv("SPOTIFY_CLIENT_ID", "");
    const none = await spotifyLinks(db, ["AC/DC"]);
    expect(none.links.get("AC/DC")).toBe("https://open.spotify.com/search/AC%2FDC");
    expect(none.problem).toMatch(/SPOTIFY_CLIENT_ID/);
    expect(fetchMock).not.toHaveBeenCalled();

    vi.stubEnv("SPOTIFY_CLIENT_ID", "id");
    fetchMock.mockResolvedValue(json({ error: "invalid_client", error_description: "Invalid client" }, 400));
    const { links, problem } = await spotifyLinks(db, ["A", "B", "C"]);
    expect(problem).toBe("Spotify token request returned HTTP 400 (Invalid client)");
    expect([...links.values()].every((u) => u.includes("/search/"))).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1); // gave up after the first failure
    expect(db.prepare("SELECT COUNT(*) AS n FROM spotify_matches").get()).toEqual({ n: 0 });
  });
});
