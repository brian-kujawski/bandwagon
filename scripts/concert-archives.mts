/**
 * Fetch a performer's Concert Archives history through parse.bot and tally
 * who shared a bill with them. Concert Archives sits behind a Cloudflare bot
 * challenge, so this goes through the user's parse.bot subscription to the
 * marketplace "concertarchives.org API" rather than fetching pages directly.
 *
 * Credits are scarce, so the script:
 *   - only calls get_performer_concerts (2 credits per page of ~50 rows);
 *     show titles already carry the lineup, so no per-concert details calls
 *   - caches every response under data/concert-archives/raw/ and never
 *     re-fetches a cached page
 *   - stops before a call would take it over --budget credits
 *   - waits --delay seconds between live calls
 *
 * Usage (Node 22.18+ runs TypeScript directly):
 *   PARSE_API_KEY=pmx_... PARSE_SCRAPER_ID=<id> \
 *     node scripts/concert-archives.mts pup--5 --name PUP --max-pages 3 --budget 10
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { summariseConcerts, type CaConcertRow } from "../src/lib/concertArchives.ts";

const API = "https://api.parse.bot";
const PAGE_COST = 2; // get_performer_concerts price in the marketplace listing
const OUT_DIR = path.join("data", "concert-archives");

type ConcertsPage = {
  page: number;
  has_next: boolean;
  performer_slug: string;
  concerts: CaConcertRow[];
};

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    name: { type: "string" },
    "max-pages": { type: "string", default: "3" },
    budget: { type: "string", default: "10" },
    delay: { type: "string", default: "15" },
  },
});

const slug = positionals[0];
const apiKey = process.env.PARSE_API_KEY;
const scraperId = process.env.PARSE_SCRAPER_ID;
if (!slug || !apiKey || !scraperId) {
  console.error(
    "usage: PARSE_API_KEY=... PARSE_SCRAPER_ID=... node scripts/concert-archives.mts <performer-slug> [--name PUP] [--max-pages 3] [--budget 10] [--delay 15]",
  );
  process.exit(1);
}
const seedName = values.name ?? slug.replace(/--\d+$/, "");
const maxPages = Number(values["max-pages"]);
const budget = Number(values.budget);
const delayMs = Number(values.delay) * 1000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let creditsSpent = 0;
let lastLiveCall = 0;

async function callEndpoint(endpoint: string, params: Record<string, string>, attempt = 1): Promise<unknown> {
  const wait = lastLiveCall + delayMs - Date.now();
  if (wait > 0) await sleep(wait);
  lastLiveCall = Date.now();

  const url = `${API}/scraper/${scraperId}/${endpoint}?${new URLSearchParams(params)}`;
  const started = Date.now();
  const res = await fetch(url, {
    headers: { "X-API-Key": apiKey! },
    signal: AbortSignal.timeout(240_000),
  });
  const charged = Number(res.headers.get("x-credits-charged") ?? 0);
  creditsSpent += charged;
  const remaining = res.headers.get("x-credits-remaining");
  console.log(
    `  ${endpoint} ${JSON.stringify(params)} -> ${res.status} in ${((Date.now() - started) / 1000).toFixed(1)}s, ` +
      `charged ${charged}, balance ${remaining ?? "?"}`,
  );

  if (res.ok) return ((await res.json()) as { data: unknown }).data;

  const body = await res.text();
  // parse.bot sometimes stalls ~2 minutes and then answers a valid key with
  // 401. Those calls aren't charged, so one retry is cheap.
  const retryable =
    (res.status === 401 && Date.now() - started > 60_000) ||
    res.status === 429 ||
    (res.status === 503 && res.headers.has("retry-after"));
  if (retryable && attempt === 1) {
    const after = Number(res.headers.get("retry-after") ?? 20);
    console.log(`  retrying once in ${after}s`);
    await sleep(after * 1000);
    return callEndpoint(endpoint, params, attempt + 1);
  }
  throw new Error(`${endpoint} failed with ${res.status}: ${body.slice(0, 300)}`);
}

async function readCached(file: string): Promise<ConcertsPage | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as ConcertsPage;
  } catch {
    return null;
  }
}

async function main() {
  const rawDir = path.join(OUT_DIR, "raw", slug);
  await mkdir(rawDir, { recursive: true });

  const rows: CaConcertRow[] = [];
  let reachedEnd = false;
  for (let page = 1; page <= maxPages; page++) {
    const file = path.join(rawDir, `concerts-page-${page}.json`);
    let data = await readCached(file);
    if (data) {
      console.log(`page ${page}: cached`);
    } else {
      if (creditsSpent + PAGE_COST > budget) {
        console.log(`page ${page}: skipped, would exceed the ${budget}-credit budget`);
        break;
      }
      console.log(`page ${page}: fetching`);
      data = (await callEndpoint("get_performer_concerts", { slug, page: String(page) })) as ConcertsPage;
      await writeFile(file, JSON.stringify(data, null, 2));
    }
    rows.push(...data.concerts);
    if (!data.has_next) {
      reachedEnd = true;
      break;
    }
  }

  const summary = summariseConcerts(rows, seedName);
  const outFile = path.join(OUT_DIR, `${slug}.json`);
  await writeFile(outFile, JSON.stringify({ ...summary, reachedEnd, fetchedAt: new Date().toISOString() }, null, 2));

  const kept = summary.shows.length - summary.festivalsSkipped;
  console.log(
    `\n${seedName}: ${summary.rows} rows, ${summary.duplicates} duplicates, ` +
      `${summary.festivalsSkipped} festivals skipped, ${kept} shows kept (${summary.noLineup} with no lineup in the title)` +
      `${reachedEnd ? "" : ", more pages remain"}`,
  );
  console.log(`credits spent this run: ${creditsSpent}`);
  console.log(`\nshared a bill with ${summary.coBills.length} acts:`);
  for (const c of summary.coBills.slice(0, 25)) {
    const dates = c.shows.map((s) => s.date ?? "?").join(", ");
    console.log(`  ${String(c.shows.length).padStart(3)}  ${c.name}  (${dates})`);
  }
  console.log(`\nwrote ${outFile}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  console.error(`credits spent before the error: ${creditsSpent}`);
  process.exit(1);
});
