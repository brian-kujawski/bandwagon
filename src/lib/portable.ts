/**
 * Move bandwagon's irreplaceable data between machines as one file.
 *
 * Only primary data travels: the vault of paid responses (vault.ts).
 * Everything derived from it is rebuilt on import, so an export stays small
 * and an older export still imports after the derived tables change.
 *
 * Import merges rather than replaces, so fetching on both machines loses
 * nothing, and importing the same file twice is harmless.
 *
 * Don't copy the live database instead: it runs in WAL mode, and a copy taken
 * while the app is running can miss recent writes that sit in the -wal file.
 */
import { existsSync, renameSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { transaction, type Db } from "./db.ts";
import { ensureVault, rebuildConcertArchives, VAULT_SCHEMA } from "./vault.ts";

export const EXPORT_FORMAT = "bandwagon-export";
export const EXPORT_VERSION = 1;

const PAYLOAD_COLUMNS = "source, endpoint, params, subject, fetched_at, credits, body, sha256";

export type ExportCounts = { payloads: number };

export function exportData(db: Db, file: string, now: string = new Date().toISOString()): ExportCounts {
  ensureVault(db);
  const tmp = `${file}.tmp`;
  rmSync(tmp, { force: true });

  const out = new DatabaseSync(tmp);
  out.exec(VAULT_SCHEMA);
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
    });
  } finally {
    db.exec("DETACH DATABASE export");
  }
  rmSync(file, { force: true });
  renameSync(tmp, file);
  return { payloads: count(db, "payloads") };
}

export type ImportCounts = { payloadsAdded: number; payloadsInFile: number };

/** Merge an export into this database, then rebuild what derives from it. */
export function importData(db: Db, file: string): ImportCounts {
  if (!existsSync(file)) throw new Error(`no such file: ${file}`);
  checkExport(file);
  ensureVault(db);

  const before = count(db, "payloads");
  db.prepare("ATTACH DATABASE ? AS incoming").run(file);
  let inFile = 0;
  try {
    transaction(db, () => {
      inFile = count(db, "incoming.payloads");
      db.exec(
        `INSERT OR IGNORE INTO main.payloads (${PAYLOAD_COLUMNS})
         SELECT ${PAYLOAD_COLUMNS} FROM incoming.payloads ORDER BY id`,
      );
      rebuildConcertArchives(db);
    });
  } finally {
    db.exec("DETACH DATABASE incoming");
  }
  return { payloadsAdded: count(db, "payloads") - before, payloadsInFile: inFile };
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
