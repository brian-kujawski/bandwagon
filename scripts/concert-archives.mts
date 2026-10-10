/**
 * Fetch a performer's Concert Archives history through parse.bot and tally
 * who shared a bill with them. Concert Archives sits behind a Cloudflare bot
 * challenge, so this goes through the user's parse.bot subscription to the
 * marketplace "concertarchives.org API" rather than fetching pages directly.
 *
 * Credits are scarce, so the script:
 *   - only calls get_performer_concerts (2 credits per page of ~50 rows);
 *     show titles already carry the lineup, so no per-concert details calls
 *   - stores every response in the database's vault (src/lib/vault.ts) and
 *     under data/concert-archives/raw/, and never re-fetches a page either holds
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
import { DEFAULT_DB_FILE, openDb } from "../src/lib/db.ts";
import { parseBotClient, ParseBotError } from "../src/lib/parsebot.ts";
import { addPayload, canonicalParams, ensureVault, rebuildConcertArchives } from "../src/lib/vault.ts";

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

const client = parseBotClient({ apiKey, scraperId }, { delayMs, log: (line) => console.log(`  ${line}`) });
let creditsSpent = 0;

async function callEndpoint(endpoint: "get_performer_concerts", params: Record<string, string>): Promise<unknown> {
  try {
    const { data, credits } = await client.call(endpoint, params);
    creditsSpent += credits;
    return data;
  } catch (e) {
    if (e instanceof ParseBotError) creditsSpent += e.credits;
    throw e;
  }
}

const db = openDb(process.env.BANDWAGON_DB || DEFAULT_DB_FILE);
ensureVault(db);

/** The newest stored copy of a page: the vault first, then the page file. */
async function readCached(page: number, file: string): Promise<ConcertsPage | null> {
  const stored = db
    .prepare(
      `SELECT body FROM payloads WHERE source = 'parsebot' AND endpoint = 'get_performer_concerts' AND params = ?
       ORDER BY fetched_at DESC LIMIT 1`,
    )
    .get(canonicalParams({ slug, page: String(page) })) as { body: string } | undefined;
  if (stored) return JSON.parse(stored.body) as ConcertsPage;
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
    let data = await readCached(page, file);
    if (data) {
      console.log(`page ${page}: cached`);
    } else {
      if (creditsSpent + PAGE_COST > budget) {
        console.log(`page ${page}: skipped, would exceed the ${budget}-credit budget`);
        break;
      }
      console.log(`page ${page}: fetching`);
      const params = { slug, page: String(page) };
      const creditsBefore = creditsSpent;
      data = (await callEndpoint("get_performer_concerts", params)) as ConcertsPage;
      addPayload(db, {
        source: "parsebot",
        endpoint: "get_performer_concerts",
        params,
        subject: seedName,
        fetchedAt: new Date().toISOString(),
        credits: creditsSpent - creditsBefore,
        body: data,
      });
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
  const rebuilt = rebuildConcertArchives(db);
  console.log(`vault: ${rebuilt.performers} performers, ${rebuilt.concerts} concerts; graph updated`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  console.error(`credits spent before the error: ${creditsSpent}`);
  process.exit(1);
});
