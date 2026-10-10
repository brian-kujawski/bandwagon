"use server";

import { refresh } from "next/cache";
import { getDb } from "@/lib/db";
import { isMbid } from "@/lib/musicbrainz";
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
