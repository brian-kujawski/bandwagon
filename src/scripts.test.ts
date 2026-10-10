import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

/**
 * The scripts run under Node's own TypeScript type stripping, not through
 * Vite, so syntax it can't strip (constructor parameter properties, enums)
 * only fails there. Load each one for real.
 */
const run = (...args: string[]) =>
  spawnSync(process.execPath, args, {
    encoding: "utf8",
    env: { ...process.env, BANDWAGON_DB: ":memory:", NODE_NO_WARNINGS: "1", PARSE_API_KEY: "", PARSE_SCRAPER_ID: "" },
  });

describe("scripts load under Node", () => {
  it.each([
    ["scripts/data.mts", "status"],
    ["scripts/graph.mts", "stats"],
  ])("%s %s", (script, command) => {
    const r = run(script, command);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
  });

  it("scripts/concert-archives.mts", () => {
    // Without a key it stops at its usage line, after every import has loaded.
    expect(run("scripts/concert-archives.mts").stderr).toMatch(/^usage:/);
  });
});
