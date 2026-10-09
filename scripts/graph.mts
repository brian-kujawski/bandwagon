/**
 * Poke at the local co-bill store (data/bandwagon.db, or BANDWAGON_DB).
 *
 *   node scripts/graph.mts load-ca data/concert-archives/pup--5.json
 *       Load a Concert Archives summary written by scripts/concert-archives.mts.
 *       The slug defaults to the file name; pass --slug to override.
 *   node scripts/graph.mts links "PUP" ["Another band" ...]
 *       Print direct and one-step-further recommendations for stored bands.
 *   node scripts/graph.mts stats
 *       Count what is stored.
 *
 * Reads only local files and the database: no API calls, no credits.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { normName, type CaSummary } from "../src/lib/concertArchives.ts";
import { DEFAULT_DB_FILE, openDb } from "../src/lib/db.ts";
import { describeBridge, describeDirect, recommendFromGraph } from "../src/lib/graph.ts";
import { ingestConcertArchives } from "../src/lib/ingest.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { slug: { type: "string" }, limit: { type: "string", default: "15" } },
});
const [command, ...args] = positionals;
const dbFile = process.env.BANDWAGON_DB || DEFAULT_DB_FILE;
const db = openDb(dbFile);

async function loadCa() {
  if (args.length === 0) throw new Error("load-ca needs one or more summary files");
  for (const file of args) {
    const summary = JSON.parse(await readFile(file, "utf8")) as CaSummary;
    const slug = values.slug ?? path.basename(file, ".json");
    const { shows } = ingestConcertArchives(db, summary, slug);
    console.log(`${summary.seed} (${slug}): stored ${shows} co-billed shows from ${file}`);
  }
}

function links() {
  if (args.length === 0) throw new Error("links needs one or more band names");
  const seedIds = args.map((name) => {
    const rows = db.prepare("SELECT id FROM artists WHERE norm_name = ?").all(normName(name)) as { id: number }[];
    if (rows.length === 0) throw new Error(`no stored artist called ${name}`);
    if (rows.length > 1) console.warn(`${rows.length} stored artists called ${name}; using the first`);
    return rows[0].id;
  });
  const limit = Number(values.limit);
  const today = new Date().toISOString().slice(0, 10);
  const { direct, oneStep } = recommendFromGraph(db, seedIds, limit);

  console.log(`\nSharing bills (${direct.length}):`);
  for (const c of direct) {
    console.log(`  ${c.score.toFixed(2).padStart(6)}  ${c.artist.name}`);
    for (const d of c.direct) console.log(`          ${describeDirect(d, today)}`);
  }
  console.log(`\nOne step further (${oneStep.length}):`);
  for (const c of oneStep) {
    console.log(`  ${c.score.toFixed(2).padStart(6)}  ${c.artist.name}`);
    for (const b of c.bridges.slice(0, 3)) console.log(`          ${describeBridge(b)}`);
  }
}

function stats() {
  const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
  console.log(`${dbFile}:`);
  console.log(`  artists      ${count("SELECT COUNT(*) AS n FROM artists")}`);
  console.log(`  events       ${count("SELECT COUNT(*) AS n FROM events")}`);
  console.log(`  appearances  ${count("SELECT COUNT(*) AS n FROM appearances")}`);
  console.log(`  co-bill pairs ${count("SELECT COUNT(*) / 2 AS n FROM (SELECT DISTINCT a, b FROM cobills)")}`);
  const sources = db.prepare("SELECT source, COUNT(*) AS n FROM events GROUP BY source").all() as {
    source: string;
    n: number;
  }[];
  for (const s of sources) console.log(`  events from ${s.source}: ${s.n}`);
}

const commands: Record<string, () => unknown> = { "load-ca": loadCa, links, stats };
const run = commands[command ?? ""];
if (!run) {
  console.error("usage: node scripts/graph.mts load-ca <summary.json>... | links <band>... | stats");
  process.exit(1);
}
Promise.resolve(run()).catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
