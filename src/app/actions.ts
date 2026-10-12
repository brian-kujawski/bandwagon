"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { clientFromEnv, pickPerformer, queueCheck, runQueuedChecks } from "@/lib/backfill";
import { getDb } from "@/lib/db";
import { nameOfPlace } from "@/lib/geocode";
import { homeProblem, setHome } from "@/lib/home";
import { estimatePull } from "@/lib/metro";
import { isMbid } from "@/lib/musicbrainz";
import { parseBotConfig } from "@/lib/parsebot";
import { setPref, type PrefStatus } from "@/lib/prefs";
import { refreshAreaIfDue } from "@/lib/recommend";

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
  return back && /^\/bands(\?|$)/.test(back) ? back : "/bands";
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

const num = (form: FormData, key: string) => {
  const v = text(form, key);
  return v === null ? NaN : Number(v);
};

const settingsUrl = (params: Record<string, string | number>) =>
  `/settings?${new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]))}`;

/**
 * Set home and radius. A move into an area never pulled before would spend
 * JamBase calls, so unless the form says it was confirmed, that goes back to
 * the settings page to show the cost first. Anything already stored (a
 * smaller radius, a move back) saves straight away.
 */
export async function chooseHome(form: FormData): Promise<void> {
  const db = getDb();
  const lat = num(form, "lat");
  const lon = num(form, "lon");
  const radiusMiles = num(form, "r");
  let label = text(form, "label");
  if (!label && Number.isFinite(lat) && Number.isFinite(lon)) {
    // From the browser's location: look up a name, or fall back to the numbers.
    label = await nameOfPlace(db, lat, lon).catch(() => null);
    label ??= `${lat.toFixed(3)}, ${lon.toFixed(3)}`;
  }
  const home = { label: label ?? "", lat, lon, radiusMiles };
  const problem = homeProblem(home);
  if (problem) redirect(settingsUrl({ problem }));
  if (text(form, "confirmed") !== "1" && estimatePull(db, home).kind === "new") {
    redirect(settingsUrl({ confirm: 1, label: home.label, lat, lon, r: radiusMiles }));
  }
  setHome(db, home);
  after(() => refreshAreaIfDue(getDb()));
  redirect(settingsUrl({ saved: 1 }));
}
