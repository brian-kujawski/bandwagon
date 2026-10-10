/**
 * Move bandwagon's irreplaceable data between machines as one file.
 *
 * Only primary data travels: the vault of paid responses (vault.ts), your
 * liked and not-interested bands (prefs.ts), and the monthly API call counts
 * (budget.ts). Everything derived from them is rebuilt on import, so an
 * export stays small and an older export still imports after the derived
 * tables change.
 *
 * Import merges rather than replaces, so fetching on both machines loses
 * nothing, and importing the same file twice is harmless.
 *
 * Don't copy the live database instead: it runs in WAL mode, and a copy taken
 * while the app is running can miss recent writes that sit in the -wal file.
 */
import { existsSync, renameSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { BUDGET_SCHEMA } from "./budget.ts";
import { transaction, type Db } from "./db.ts";
import { ensurePrefs, PREFS_SCHEMA } from "./prefs.ts";
import { ensureVault, rebuildConcertArchives, VAULT_SCHEMA } from "./vault.ts";

export const EXPORT_FORMAT = "bandwagon-export";
export const EXPORT_VERSION = 1;

const PAYLOAD_COLUMNS = "source, endpoint, params, subject, fetched_at, credits, body, sha256";
const PREF_COLUMNS = "key, name, mbid, jambase_id, ca_slug, status, updated_at";
const CALL_COLUMNS = "source, month, machine, calls";

function ensureAll(db: Db): void {
  ensureVault(db);
  ensurePrefs(db);
  db.exec(BUDGET_SCHEMA);
}

export type ExportCounts = { payloads: number; prefs: number };

export function exportData(db: Db, file: string, now: string = new Date().toISOString()): ExportCounts {
  ensureAll(db);
  const tmp = `${file}.tmp`;
  rmSync(tmp, { force: true });

  const out = new DatabaseSync(tmp);
  out.exec(VAULT_SCHEMA);
  out.exec(PREFS_SCHEMA);
  out.exec(BUDGET_SCHEMA);
  out.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  const meta = out.prepare("INSERT INTO meta (key, value) VALUES (?, ?)");
  meta.run("format", EXPORT_FORMAT);
  meta.run("version", String(EXPORT_VERSION));
  meta.run("exported_at", now);
  out.close();

  db.prepare("ATTACH DATABASE ? AS export").run(tmp);
  try {
    transaction(db, () => {
      db.exec(`INSERT INTO export.payloads (${PAYLOAD_COLUMNS}) SELECT ${PAYLOAD_COLUMNS} FROM main.payloads ORDER BY id`);
      db.exec(`INSERT INTO export.band_prefs (${PREF_COLUMNS}) SELECT ${PREF_COLUMNS} FROM main.band_prefs`);
      db.exec(`INSERT INTO export.api_calls (${CALL_COLUMNS}) SELECT ${CALL_COLUMNS} FROM main.api_calls`);
    });
  } finally {
    db.exec("DETACH DATABASE export");
  }
  rmSync(file, { force: true });
  renameSync(tmp, file);
  return { payloads: count(db, "payloads"), prefs: count(db, "band_prefs") };
}

export type ImportCounts = { payloadsAdded: number; payloadsInFile: number; prefsInFile: number };

/** Merge an export into this database, then rebuild what derives from it. */
export function importData(db: Db, file: string): ImportCounts {
  if (!existsSync(file)) throw new Error(`no such file: ${file}`);
  checkExport(file);
  ensureAll(db);

  const before = count(db, "payloads");
  db.prepare("ATTACH DATABASE ? AS incoming").run(file);
  let inFile = 0;
  let prefsInFile = 0;
  try {
    transaction(db, () => {
      inFile = count(db, "incoming.payloads");
      prefsInFile = count(db, "incoming.band_prefs");
      db.exec(
        `INSERT OR IGNORE INTO main.payloads (${PAYLOAD_COLUMNS})
         SELECT ${PAYLOAD_COLUMNS} FROM incoming.payloads ORDER BY id`,
      );
      // The newer choice about a band wins, including removing it.
      db.exec(
        `INSERT INTO main.band_prefs (${PREF_COLUMNS})
         SELECT ${PREF_COLUMNS} FROM incoming.band_prefs WHERE true
         ON CONFLICT (key) DO UPDATE SET
           name = excluded.name, mbid = excluded.mbid, jambase_id = excluded.jambase_id,
           ca_slug = excluded.ca_slug, status = excluded.status, updated_at = excluded.updated_at
         WHERE excluded.updated_at > band_prefs.updated_at`,
      );
      // Each machine's own count only grows, so the larger one is the latest.
      db.exec(
        `INSERT INTO main.api_calls (${CALL_COLUMNS})
         SELECT ${CALL_COLUMNS} FROM incoming.api_calls WHERE true
         ON CONFLICT (source, month, machine) DO UPDATE SET calls = MAX(calls, excluded.calls)`,
      );
      rebuildConcertArchives(db);
    });
  } finally {
    db.exec("DETACH DATABASE incoming");
  }
  return { payloadsAdded: count(db, "payloads") - before, payloadsInFile: inFile, prefsInFile };
}

function checkExport(file: string): void {
  const src = new DatabaseSync(file, { readOnly: true });
  try {
    const rows = src.prepare("SELECT key, value FROM meta").all() as { key: string; value: string }[];
    const meta = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    if (meta.format !== EXPORT_FORMAT) throw new Error(`${file} is not a bandwagon export`);
    if (Number(meta.version) > EXPORT_VERSION) {
      throw new Error(`${file} is export version ${meta.version}; this code reads up to ${EXPORT_VERSION}. Update bandwagon first.`);
    }
  } catch (e) {
    if (e instanceof Error && /no such table: meta/.test(e.message)) throw new Error(`${file} is not a bandwagon export`);
    throw e;
  } finally {
    src.close();
  }
}

const count = (db: Db, table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
