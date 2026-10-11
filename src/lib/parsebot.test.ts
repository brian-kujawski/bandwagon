import { describe, expect, it } from "vitest";
import { describeConfig, parseBotClient, parseBotConfig } from "./parsebot";

const config = { apiKey: "pmx_0123456789abcdef", scraperId: "75c8b64f" };

describe("parse.bot client", () => {
  it("reads the key and scraper ID, trimmed", () => {
    expect(parseBotConfig({ PARSE_API_KEY: " pmx_0123456789abcdef ", PARSE_SCRAPER_ID: "75c8b64f\r" })).toEqual({
      ...config,
      baseUrl: undefined,
    });
    expect(parseBotConfig({ PARSE_API_KEY: "pmx_x" })).toBeNull();
  });

  it("describes the key without showing it", () => {
    expect(describeConfig(config)).toBe("key pmx_…cdef (20 characters), scraper 75c8b64f");
  });

  it("says which key and scraper a rejected call used", async () => {
    const seen: { url: string; key: string }[] = [];
    const client = parseBotClient(config, {
      delayMs: 0,
      fetch: async (url, init) => {
        seen.push({ url: String(url), key: (init?.headers as Record<string, string>)["X-API-Key"] });
        return new Response(JSON.stringify({ error: "Invalid API key", status_code: 401 }), { status: 401 });
      },
    });
    await expect(client.call("get_performer_concerts", { slug: "pup--5", page: "1" })).rejects.toThrow(
      'get_performer_concerts failed with 401: {"error":"Invalid API key","status_code":401} (the app sent key pmx_…cdef (20 characters), scraper 75c8b64f)',
    );
    expect(seen).toEqual([
      {
        url: "https://api.parse.bot/scraper/75c8b64f/get_performer_concerts?slug=pup--5&page=1",
        key: "pmx_0123456789abcdef",
      },
    ]);
  });
});
