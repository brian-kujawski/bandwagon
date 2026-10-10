import { beforeEach, describe, expect, it } from "vitest";
import {
  candidatesOf,
  getCheck,
  historyComplete,
  historyCutoff,
  ledgerFor,
  pickPerformer,
  queueCheck,
  runCheck,
  runQueuedChecks,
  type Performer,
} from "./backfill";
import type { CaConcertRow } from "./concertArchives";
import { openDb, type Db } from "./db";
import { ParseBotError, type Endpoint, type ParseBotClient } from "./parsebot";
import { getPrefByKey, prefKey, setPref } from "./prefs";

const NOW = new Date("2026-10-10T12:00:00Z");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** A show every two months, newest first, from Dec 2026 back to Jan 2018. */
function history(prefix = "pup"): CaConcertRow[] {
  const rows: CaConcertRow[] = [];
  for (let y = 2026; y >= 2018; y--) {
    for (let m = 11; m >= 0; m -= 2) {
      rows.push({
        date: `${MONTHS[m]} 15, ${y}`,
        title: `PUP / Opener ${y}-${m}`,
        slug: `${prefix}-${y}-${m}`,
        venue: "Venue",
      });
    }
  }
  return rows;
}

/** A parse.bot stand-in serving `rows` four to a page, and recording each call. */
function fakeClient(opts: { rows?: CaConcertRow[]; performers?: Performer[]; fail?: boolean } = {}) {
  const calls: string[] = [];
  let rows = opts.rows ?? history();
  const client: ParseBotClient & { calls: string[]; setRows(r: CaConcertRow[]): void } = {
    calls,
    setRows: (r) => {
      rows = r;
    },
    async call(endpoint: Endpoint, params: Record<string, string>) {
      calls.push(endpoint === "search_performers" ? `search ${params.query}` : `page ${params.page}`);
      if (opts.fail) throw new ParseBotError(endpoint, 401, "Invalid API key", 0);
      if (endpoint === "search_performers") {
        return {
          data: { page: 1, has_next: false, results: opts.performers ?? [{ name: "PUP", slug: "pup--5", concert_count: 900 }] },
          credits: 2,
        };
      }
      const page = Number(params.page);
      const concerts = rows.slice((page - 1) * 4, page * 4);
      return {
        data: { page, has_next: page * 4 < rows.length, performer_slug: params.slug, concerts },
        credits: 2,
      };
    },
  };
  return client;
}

const KEY = prefKey({ name: "PUP" });

let db: Db;
beforeEach(() => {
  db = openDb(":memory:");
  setPref(db, { name: "PUP" }, "liked");
});

async function check(client: ParseBotClient, maxCredits = 30) {
  expect(queueCheck(db, KEY, NOW)).toBe(true);
  return runCheck(db, KEY, client, { now: NOW, maxCredits });
}

describe("concert history checks", () => {
  it("finds the band, then pages back five years and stops", async () => {
    const client = fakeClient();
    const row = await check(client);
    // Pages hold 4 shows two months apart; page 9 is the first past Oct 10, 2021.
    expect(historyCutoff(NOW)).toBe("2021-10-10");
    expect(client.calls).toEqual(["search PUP", ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((p) => `page ${p}`)]);
    expect(row).toMatchObject({ state: "done", credits: 20 });
    expect(getPrefByKey(db, KEY)?.ca_slug).toBe("pup--5");
    const ledger = ledgerFor(db, "pup--5");
    expect(ledger).toMatchObject({ concerts: 36, max_page: 9, credits: 18 });
    expect(historyComplete(ledger, NOW)).toBe(true);
    expect(row.message).toBe("Reached 5 years back.");
  });

  it("never spends past the per-check credit limit, and a later check carries on", async () => {
    const client = fakeClient();
    const first = await check(client, 7);
    expect(client.calls).toEqual(["search PUP", "page 1", "page 2"]);
    expect(first).toMatchObject({ state: "done", credits: 6 });
    expect(first.message).toContain("7-credit limit");
    expect(historyComplete(ledgerFor(db, "pup--5"), NOW)).toBe(false);

    client.calls.length = 0;
    const second = await check(client, 7);
    // Page 1 again for new shows; it overlaps, so the check jumps past page 2.
    expect(client.calls).toEqual(["page 1", "page 3", "page 4"]);
    expect(second.credits).toBe(6);
  });

  it("refetches only the top of the list once five years are stored", async () => {
    const client = fakeClient();
    await check(client);
    client.calls.length = 0;
    // Five new shows were added at the top since.
    const fresh = [1, 2, 3, 4, 5].map((n) => ({ date: "Dec 20, 2026", title: `PUP / New ${n}`, slug: `new-${n}`, venue: "V" }));
    client.setRows([...fresh, ...history()]);
    const row = await check(client);
    expect(client.calls).toEqual(["page 1", "page 2"]);
    expect(row).toMatchObject({ state: "done", credits: 4 });
    expect(ledgerFor(db, "pup--5")?.concerts).toBe(41);
  });

  it("asks which performer when the name matches several, then checks the one picked", async () => {
    const performers = [
      { name: "PUP", slug: "pup", concert_count: 3 },
      { name: "PUP", slug: "pup--5", concert_count: 900 },
      { name: "Pupil", slug: "pupil", concert_count: 40 },
    ];
    const client = fakeClient({ performers });
    const row = await check(client);
    expect(row.state).toBe("pick");
    expect(candidatesOf(row).map((c) => c.slug)).toEqual(["pup--5", "pup"]);
    expect(client.calls).toEqual(["search PUP"]);

    expect(pickPerformer(db, KEY, "pupil", NOW)).toBe(false);
    expect(pickPerformer(db, KEY, "pup--5", NOW)).toBe(true);
    client.calls.length = 0;
    await runCheck(db, KEY, client, { now: NOW, maxCredits: 4 });
    expect(client.calls).toEqual(["page 1", "page 2"]);
  });

  it("reuses a search the vault already holds", async () => {
    const client = fakeClient({ performers: [{ name: "Pup Band", slug: "pup-band", concert_count: 1 }, { name: "PUPS", slug: "pups", concert_count: 1 }] });
    await check(client);
    client.calls.length = 0;
    const again = await check(client);
    expect(client.calls).toEqual([]);
    expect(again.state).toBe("pick");
  });

  it("records a failed call without blocking the next check", async () => {
    const row = await check(fakeClient({ fail: true }));
    expect(row).toMatchObject({ state: "failed", credits: 0 });
    expect(row.message).toContain("401");
    expect(queueCheck(db, KEY, NOW)).toBe(true);
  });

  it("checks only liked bands, one queued check at a time", () => {
    setPref(db, { name: "Nope" }, "not_interested");
    expect(queueCheck(db, prefKey({ name: "Nope" }), NOW)).toBe(false);
    expect(queueCheck(db, KEY, NOW)).toBe(true);
    expect(queueCheck(db, KEY, NOW)).toBe(false);
  });

  it("runs queued checks in order and marks one cut off by a restart", async () => {
    setPref(db, { name: "Charly Bliss" }, "liked");
    const other = prefKey({ name: "Charly Bliss" });
    queueCheck(db, other, NOW);
    db.prepare("UPDATE ca_backfill SET state = 'running' WHERE key = ?").run(other);
    queueCheck(db, KEY, NOW);
    const client = fakeClient();
    await runQueuedChecks(db, client, { now: NOW, maxCredits: 4 });
    expect(getCheck(db, other)).toMatchObject({ state: "failed" });
    expect(getCheck(db, other)?.message).toContain("Interrupted");
    expect(getCheck(db, KEY)).toMatchObject({ state: "done" });
    expect(await runQueuedChecks(db, null)).toBeUndefined();
  });
});
