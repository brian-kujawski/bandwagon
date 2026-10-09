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
 *
 * Reads only local files and the database: no API calls, no credits.
 */
import path from "node:path";
import { DEFAULT_DB_FILE, openDb } from "../src/lib/db.ts";
import { exportData, importData } from "../src/lib/portable.ts";
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
  const { payloads } = exportData(db, file);
  console.log(`wrote ${file}: ${payloads} stored responses`);
}

function importCmd() {
  if (!args[0]) throw new Error("import needs an export file");
  const { payloadsAdded, payloadsInFile } = importData(db, args[0]);
  console.log(`${args[0]}: ${payloadsInFile} stored responses, ${payloadsAdded} new here`);
  status();
}

const commands: Record<string, () => void> = {
  "import-raw": importRaw,
  rebuild,
  status,
  export: exportCmd,
  import: importCmd,
};
const run = commands[command ?? ""];
if (!run) {
  console.error("usage: node scripts/data.mts import-raw [dir] | rebuild | status | export [file] | import <file>");
  process.exit(1);
}
try {
  run();
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
