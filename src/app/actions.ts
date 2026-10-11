"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { clientFromEnv, pickPerformer, queueCheck, runQueuedChecks } from "@/lib/backfill";
import { getDb } from "@/lib/db";
import { isMbid } from "@/lib/musicbrainz";
import { parseBotConfig } from "@/lib/parsebot";
import { setPref, type PrefStatus } from "@/lib/prefs";

const STATUSES: PrefStatus[] = ["liked", "not_interested", "cleared"];

const text = (form: FormData, key: string) => {
  const v = form.get(key);
  return typeof v === "string" && v.trim() ? v.trim() : null;
};

/**
 * Like a band, mark it not interested, or clear either. bandwagon runs on
 * your own machine for one person, so there is no sign-in to check here.
 */
export async function setBandPref(form: FormData): Promise<void> {
  const name = text(form, "name");
  const status = text(form, "status") as PrefStatus | null;
  if (!name || !status || !STATUSES.includes(status)) throw new Error("bad band preference");
  const mbid = text(form, "mbid");
  setPref(getDb(), {
    name,
    mbid: mbid && isMbid(mbid) ? mbid : null,
    jambaseId: text(form, "jambase_id"),
    caSlug: text(form, "ca_slug"),
  }, status);
  refresh();
}

/** Only ever send people back to the bands page. */
const backTo = (form: FormData) => {
  const back = text(form, "back");
  return back && /^\/likes(\?|$)/.test(back) ? back : "/likes";
};

/**
 * Check a liked band's Concert Archives history. Spends parse.bot credits, so
 * the page only offers this after the user confirms. The check runs after the
 * response, one band at a time, and the page shows how it is going.
 */
export async function startHistoryCheck(form: FormData): Promise<void> {
  const key = text(form, "key");
  if (!key) throw new Error("no band to check");
  if (!parseBotConfig()) throw new Error("PARSE_API_KEY and PARSE_SCRAPER_ID aren't set");
  queueCheck(getDb(), key);
  after(() => runQueuedChecks(getDb(), clientFromEnv()));
  redirect(backTo(form));
}

/** Pick which Concert Archives performer a band is, then check its history. */
export async function pickHistoryPerformer(form: FormData): Promise<void> {
  const key = text(form, "key");
  const slug = text(form, "slug");
  if (!key || !slug) throw new Error("no performer picked");
  if (!parseBotConfig()) throw new Error("PARSE_API_KEY and PARSE_SCRAPER_ID aren't set");
  pickPerformer(getDb(), key, slug);
  after(() => runQueuedChecks(getDb(), clientFromEnv()));
  redirect(backTo(form));
}
