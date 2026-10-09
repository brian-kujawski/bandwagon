/**
 * Monthly API call budgets. JamBase's free tier allows 1,000 calls a month and
 * charges for more, so the app counts every call it makes and stops before
 * the budget instead of running into overage.
 *
 * Counts are kept per machine and travel in exports (portable.ts), so the
 * Windows PC and the Linux machine see each other's spending once synced.
 * Both use the same key, so the month's total is the sum across machines.
 */
import { hostname } from "node:os";
import type { Db } from "./db.ts";

export type BudgetSource = "jambase";

export const BUDGET_SCHEMA = `
CREATE TABLE IF NOT EXISTS api_calls (
  source TEXT NOT NULL,
  month TEXT NOT NULL,             -- YYYY-MM, UTC
  machine TEXT NOT NULL,
  calls INTEGER NOT NULL,
  PRIMARY KEY (source, month, machine)
);
`;

/** Leaves 100 of the free 1,000 for scripts and slack. Override with JAMBASE_MONTHLY_BUDGET. */
export function monthlyBudget(source: BudgetSource): number {
  const n = Number(process.env.JAMBASE_MONTHLY_BUDGET ?? 900);
  return source === "jambase" && Number.isFinite(n) && n >= 0 ? n : 900;
}

const monthOf = (now: Date) => now.toISOString().slice(0, 7);

export function callsThisMonth(db: Db, source: BudgetSource, now: Date = new Date()): number {
  db.exec(BUDGET_SCHEMA);
  const row = db
    .prepare("SELECT COALESCE(SUM(calls), 0) AS n FROM api_calls WHERE source = ? AND month = ?")
    .get(source, monthOf(now)) as { n: number };
  return row.n;
}

export function remainingCalls(db: Db, source: BudgetSource, now: Date = new Date()): number {
  return Math.max(0, monthlyBudget(source) - callsThisMonth(db, source, now));
}

export function recordCalls(db: Db, source: BudgetSource, calls: number, now: Date = new Date()): void {
  if (calls <= 0) return;
  db.exec(BUDGET_SCHEMA);
  db.prepare(
    `INSERT INTO api_calls (source, month, machine, calls) VALUES (?, ?, ?, ?)
     ON CONFLICT (source, month, machine) DO UPDATE SET calls = calls + excluded.calls`,
  ).run(source, monthOf(now), hostname(), calls);
}
