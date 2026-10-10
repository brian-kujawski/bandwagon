/**
 * The user's parse.bot subscription to the marketplace "concertarchives.org
 * API". Concert Archives sits behind a Cloudflare bot challenge, so its pages
 * come through parse.bot rather than being fetched directly.
 *
 * Every call spends credits, which are scarce and fairly expensive. Nothing in
 * the app calls this on its own: only a history check the user confirmed
 * (backfill.ts) or scripts/concert-archives.mts run by hand. The key is read
 * from PARSE_API_KEY and never stored.
 */

/** Marketplace prices, in credits. */
export const PRICES = {
  search_performers: 2,
  get_performer_concerts: 2,
} as const;

export type Endpoint = keyof typeof PRICES;

export type CallResult = { data: unknown; credits: number };

/** What the history check needs from parse.bot; tests pass a fake. */
export type ParseBotClient = {
  call(endpoint: Endpoint, params: Record<string, string>): Promise<CallResult>;
};

export type ParseBotConfig = { apiKey: string; scraperId: string; baseUrl?: string };

/**
 * PARSE_API_KEY and PARSE_SCRAPER_ID, or null when either is missing.
 * PARSE_API_BASE points at a stand-in server for trying the app without credits.
 */
export function parseBotConfig(env: NodeJS.ProcessEnv = process.env): ParseBotConfig | null {
  const apiKey = env.PARSE_API_KEY?.trim();
  const scraperId = env.PARSE_SCRAPER_ID?.trim();
  const baseUrl = env.PARSE_API_BASE?.trim() || undefined;
  return apiKey && scraperId ? { apiKey, scraperId, baseUrl } : null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A client that waits `delayMs` between live calls and retries once when
 * parse.bot stalls ~2 minutes and then answers a valid key with 401 (those
 * calls aren't charged), or asks us to slow down.
 */
export function parseBotClient(
  config: ParseBotConfig,
  opts: { delayMs?: number; log?: (line: string) => void; fetch?: typeof fetch } = {},
): ParseBotClient {
  const delayMs = opts.delayMs ?? 10_000;
  const log = opts.log ?? (() => {});
  const doFetch = opts.fetch ?? fetch;
  let lastLiveCall = 0;

  async function call(endpoint: Endpoint, params: Record<string, string>, attempt = 1): Promise<CallResult> {
    const wait = lastLiveCall + delayMs - Date.now();
    if (wait > 0) await sleep(wait);
    lastLiveCall = Date.now();

    const url = `${config.baseUrl ?? "https://api.parse.bot"}/scraper/${config.scraperId}/${endpoint}?${new URLSearchParams(params)}`;
    const started = Date.now();
    const res = await doFetch(url, {
      headers: { "X-API-Key": config.apiKey },
      signal: AbortSignal.timeout(240_000),
    });
    const charged = Number(res.headers.get("x-credits-charged") ?? 0);
    log(
      `${endpoint} ${JSON.stringify(params)} -> ${res.status} in ${((Date.now() - started) / 1000).toFixed(1)}s, ` +
        `charged ${charged}, balance ${res.headers.get("x-credits-remaining") ?? "?"}`,
    );

    if (res.ok) return { data: ((await res.json()) as { data: unknown }).data, credits: charged };

    const body = await res.text();
    const retryable =
      (res.status === 401 && Date.now() - started > 60_000) ||
      res.status === 429 ||
      (res.status === 503 && res.headers.has("retry-after"));
    if (retryable && attempt === 1) {
      const after = Number(res.headers.get("retry-after") ?? 20);
      log(`retrying once in ${after}s`);
      await sleep(after * 1000);
      const retry = await call(endpoint, params, attempt + 1);
      return { ...retry, credits: retry.credits + charged };
    }
    throw new ParseBotError(endpoint, res.status, body.slice(0, 300), charged);
  }

  return { call: (endpoint, params) => call(endpoint, params) };
}

/** A failed call. `credits` is what it cost anyway, usually 0. */
export class ParseBotError extends Error {
  readonly status: number;
  readonly credits: number;
  // No parameter properties: scripts run this file under Node's type stripping.
  constructor(endpoint: string, status: number, body: string, credits: number) {
    super(`${endpoint} failed with ${status}: ${body}`);
    this.status = status;
    this.credits = credits;
  }
}
