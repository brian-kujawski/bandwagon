/**
 * Look after bandwagon's stored data (data/bandwagon.db, or BANDWAGON_DB).
 *
 *   node scripts/data.mts import-raw [dir]
 *       Add Concert Archives pages cached by scripts/concert-archives.mts
 *       (default data/concert-archives/raw) to the vault, then rebuild.
 *   node scripts/data.mts rebuild
 *       Re-derive Concert Archives shows from the vault.
 *   node scripts/data.mts status
 *       What the vault holds, per performer.
 *   node scripts/data.mts export [file]
 *       Write everything irreplaceable to one file (default bandwagon-export.sqlite)
 *       to copy to another machine. Safe while the app is running.
 *   node scripts/data.mts import <file>
 *       Merge an export into this machine's database. Safe to repeat.
 *   node scripts/data.mts like <file> [--first]
 *       Like every band in a text or CSV file (one per line, first column).
 *       Looks each up on MusicBrainz, 1 per second; names shared by several
 *       artists are listed for you to pick in the app, unless --first.
 *   node --env-file=.env.local scripts/data.mts area [--check]
 *       Pull every upcoming concert around home (BANDWAGON_HOME, default
 *       100 miles around Detroit) from JamBase, or carry on a pull left
 *       partway. --check spends one call to see whether JamBase applies the
 *       area filter and how many pages a full pull takes.
 *
 * `like` calls MusicBrainz (free) and `area` calls JamBase, within the
 * monthly budget. Nothing here spends parse.bot credits.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { DEFAULT_DB_FILE, openDb } from "../src/lib/db.ts";
import { searchArtists } from "../src/lib/musicbrainz.ts";
import { exportData, importData } from "../src/lib/portable.ts";
import { callsThisMonth, monthlyBudget } from "../src/lib/budget.ts";
import { areaMonthlyCalls, pullArea } from "../src/lib/metro.ts";
import { homeFromEnv } from "../src/lib/nearby.ts";
import { likeMany, namesFromList } from "../src/lib/prefs.ts";
import { importRawPages, performerLedger, rebuildConcertArchives } from "../src/lib/vault.ts";

const [command, ...args] = process.argv.slice(2);
const dbFile = process.env.BANDWAGON_DB || DEFAULT_DB_FILE;
const db = openDb(dbFile);

function rebuild() {
  const r = rebuildConcertArchives(db);
  console.log(`rebuilt: ${r.performers} performers, ${r.concerts} concerts, ${r.shows} co-billed shows in the graph`);
}

function importRaw() {
  const dir = args[0] ?? path.join("data", "concert-archives", "raw");
  const { files, added } = importRawPages(db, dir);
  console.log(`${dir}: ${files} page files, ${added} new to the vault`);
  rebuild();
}

function status() {
  const rows = performerLedger(db);
  if (rows.length === 0) {
    console.log("The vault holds no Concert Archives pages yet. Try: node scripts/data.mts import-raw");
    return;
  }
  console.log(`${dbFile}:\n`);
  for (const r of rows) {
    console.log(
      `${r.name} (${r.slug}): ${r.concerts} concerts on ${r.pages} pages (up to page ${r.max_page}), ` +
        `${r.oldest_date ?? "?"} to ${r.newest_date ?? "?"}, ${r.credits} credits, ` +
        `${r.reached_end ? "full history" : "older pages not fetched yet"}, last fetched ${r.last_fetched_at.slice(0, 10)}`,
    );
  }
}

function exportCmd() {
  const file = args[0] ?? "bandwagon-export.sqlite";
  const { payloads, prefs } = exportData(db, file);
  console.log(`wrote ${file}: ${payloads} stored responses, ${prefs} band choices`);
}

function importCmd() {
  if (!args[0]) throw new Error("import needs an export file");
  const { payloadsAdded, payloadsInFile, prefsInFile } = importData(db, args[0]);
  console.log(
    `${args[0]}: ${payloadsInFile} stored responses (${payloadsAdded} new here), ${prefsInFile} band choices merged`,
  );
  status();
}

async function like() {
  const file = args.find((a) => !a.startsWith("--"));
  if (!file) throw new Error("like needs a file of band names");
  const names = namesFromList(readFileSync(file, "utf8"));
  console.log(`${names.length} names; about ${Math.ceil(names.length / 60)} min of MusicBrainz lookups`);
  const r = await likeMany(db, names, (name) => searchArtists(name, 10), {
    takeFirst: args.includes("--first"),
    onProgress: (i, name) => process.stdout.write(`\r${i + 1}/${names.length} ${name.slice(0, 40).padEnd(40)}`),
  });
  console.log(`\n\nliked ${r.liked.length}, already saved ${r.already.length}`);
  if (r.ambiguous.length) {
    console.log(`\nseveral artists share these names; search for them in the app to pick the right one:`);
    for (const a of r.ambiguous) console.log(`  ${a.name} (${a.matches} matches)`);
  }
  if (r.notFound.length) {
    console.log(`\nnot on MusicBrainz under these names:`);
    for (const n of r.notFound) console.log(`  ${n}`);
  }
}

async function area() {
  const home = homeFromEnv();
  const check = args.includes("--check");
  console.log(`concerts within ${home.radiusMiles} miles of ${home.lat},${home.lon}`);
  const r = await pullArea(db, home, { maxPages: check ? 1 : undefined, log: (line) => console.log(line) });
  if (r.check) {
    const c = r.check;
    console.log(
      c.ok
        ? `area filter works: ${c.located} venues on page 1, farthest ${Math.round(c.farthest)} miles`
        : `area filter NOT applied: ${r.pull.note}`,
    );
  }
  const { pull } = r;
  if (pull.total_pages) console.log(`a full pull is ${pull.total_pages} pages, one JamBase call each`);
  console.log(
    `${pull.outcome}: ${pull.concerts} concerts stored so far, ${r.calls} calls this run` +
      (r.stoppedBy === "area-cap" ? ` (stopped at the area's ${areaMonthlyCalls()} calls a month)` : "") +
      (r.stoppedBy === "budget" ? " (stopped at the monthly budget)" : ""),
  );
  console.log(`JamBase calls this month: ${callsThisMonth(db, "jambase")} of ${monthlyBudget("jambase")}`);
}

const commands: Record<string, () => void | Promise<void>> = {
  "import-raw": importRaw,
  rebuild,
  status,
  export: exportCmd,
  import: importCmd,
  like,
  area,
};
const run = commands[command ?? ""];
if (!run) {
  console.error(
    "usage: node scripts/data.mts import-raw [dir] | rebuild | status | export [file] | import <file> | like <file> [--first] | area [--check]",
  );
  process.exit(1);
}
Promise.resolve()
  .then(run)
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
