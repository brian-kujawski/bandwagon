import { setBandPref } from "./actions";
import type { BandRef, PrefStatus } from "@/lib/prefs";

/** Like / Not interested toggles for one band. Works without JavaScript. */
export function PrefButtons({ band, current }: { band: BandRef; current: PrefStatus | null }) {
  const button = (status: PrefStatus, label: string, pressed: boolean) => (
    <button type="submit" name="status" value={pressed ? "cleared" : status} aria-pressed={pressed}>
      {label}
    </button>
  );
  return (
    <form action={setBandPref} className="prefs">
      <input type="hidden" name="name" value={band.name} />
      {band.mbid && <input type="hidden" name="mbid" value={band.mbid} />}
      {band.jambaseId && <input type="hidden" name="jambase_id" value={band.jambaseId} />}
      {band.caSlug && <input type="hidden" name="ca_slug" value={band.caSlug} />}
      {button("liked", current === "liked" ? "Liked ✓" : "Like", current === "liked")}
      {button("not_interested", current === "not_interested" ? "Not interested ✓" : "Not interested", current === "not_interested")}
    </form>
  );
}
