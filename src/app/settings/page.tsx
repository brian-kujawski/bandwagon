import Link from "next/link";
import { connection } from "next/server";
import { chooseHome } from "../actions";
import { CostDialog } from "./cost-dialog";
import { UseMyLocation } from "./use-my-location";
import { getDb } from "@/lib/db";
import { parseCoordinates, searchPlaces, type Place } from "@/lib/geocode";
import { getHome, homeProblem, MAX_RADIUS_MILES, RADIUS_PRESETS, type SavedHome } from "@/lib/home";
import { areaCallsLeft, estimatePull, parseAreaKey, type PullEstimate } from "@/lib/metro";

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.trim() ?? "";

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/** Hidden fields that set home to this place and radius. */
function PlaceFields({ place, radiusMiles }: { place: Place; radiusMiles: number }) {
  return (
    <>
      <input type="hidden" name="label" value={place.label} />
      <input type="hidden" name="lat" value={place.lat} />
      <input type="hidden" name="lon" value={place.lon} />
      <input type="hidden" name="r" value={radiusMiles} />
    </>
  );
}

function RadiusPicker({ current }: { current: number }) {
  return (
    <fieldset className="radius-picker">
      <legend>Radius</legend>
      {RADIUS_PRESETS.map((r) => (
        <label key={r}>
          <input type="radio" name="r" value={r} defaultChecked={Math.round(current) === r} /> {r} mi
        </label>
      ))}
    </fieldset>
  );
}

/** What the cost warning says about a move into an area never pulled. */
function CostWarning({ place, radiusMiles, estimate, left }: { place: Place; radiusMiles: number; estimate: Extract<PullEstimate, { kind: "new" }>; left: number }) {
  const basis = estimate.basis && parseAreaKey(estimate.basis.area);
  return (
    <CostDialog title={`Pull concerts around ${place.label}?`}>
      <p>
        bandwagon hasn&apos;t pulled concerts within {radiusMiles} miles of {place.label} before, so
        switching starts a new pull from JamBase.
      </p>
      {estimate.calls !== null && basis ? (
        <p>
          <strong>About {estimate.calls} JamBase {estimate.calls === 1 ? "call" : "calls"}</strong>, scaled
          from the last full pull ({estimate.basis!.total_pages ?? estimate.basis!.calls} calls for {Math.round(basis.radiusMiles)} miles).
          Busier or quieter areas than that one will differ.
        </p>
      ) : (
        <p>
          <strong>The cost is unknown</strong>: no full area pull has finished yet to estimate from.
        </p>
      )}
      <p>
        {left} area calls are left this month. A pull that runs out stops and finishes next month,
        soonest shows first. Your current area&apos;s shows stay stored, so switching back costs nothing.
      </p>
      <div className="confirm-actions">
        <form action={chooseHome}>
          <PlaceFields place={place} radiusMiles={radiusMiles} />
          <input type="hidden" name="confirmed" value="1" />
          <button type="submit" className="danger-button">Switch and pull</button>
        </form>
        <form method="dialog">
          <button type="submit" className="small-button">Cancel</button>
        </form>
      </div>
    </CostDialog>
  );
}

function costNote(estimate: PullEstimate): string {
  switch (estimate.kind) {
    case "covered":
      return "Already stored, no JamBase calls.";
    case "pulled-before":
      return `Pulled before; shows are stored. Next monthly refresh about ${estimate.calls} calls.`;
    case "new":
      return estimate.calls === null ? "New area: cost unknown, you'll be asked first." : `New area: about ${estimate.calls} calls, you'll be asked first.`;
  }
}

function Results({ db, places, radiusMiles }: { db: ReturnType<typeof getDb>; places: Place[]; radiusMiles: number }) {
  return (
    <ul className="candidates place-results">
      {places.map((p) => (
        <li key={`${p.lat},${p.lon}`}>
          <form action={chooseHome}>
            <PlaceFields place={p} radiusMiles={radiusMiles} />
            <button type="submit" className="small-button">Use</button>
          </form>
          <span>{p.label}</span>
          <span className="meta">{costNote(estimatePull(db, { ...p, radiusMiles }))}</span>
        </li>
      ))}
    </ul>
  );
}

function CurrentHome({ home }: { home: SavedHome }) {
  return (
    <p className="lede">
      Concerts and nearby shows are within <strong>{Math.round(home.radiusMiles)} miles</strong> of{" "}
      <strong>{home.label}</strong>
      {!parseCoordinates(home.label) && ` (${home.lat.toFixed(3)}, ${home.lon.toFixed(3)})`}.
      {home.updatedAt ? ` Set ${formatDate(home.updatedAt)}.` : " This is the default."}
    </p>
  );
}

export default async function SettingsPage({ searchParams }: PageProps<"/settings">) {
  await connection(); // reads the database on every request, never at build time
  const params = await searchParams;
  const db = getDb();
  const home = getHome(db);
  const q = one(params.q);
  const wanted = Number(one(params.r));
  const radiusMiles = wanted > 0 && wanted <= MAX_RADIUS_MILES ? wanted : home.radiusMiles;

  let places: Place[] = [];
  let searchFailed: string | null = null;
  if (q) {
    try {
      places = await searchPlaces(db, q);
    } catch (e) {
      console.error("[geocode]", e);
      searchFailed = e instanceof Error ? e.message : String(e);
    }
  }

  // Sent back here by chooseHome to show what a new area would cost.
  let confirm: { place: Place; estimate: Extract<PullEstimate, { kind: "new" }> } | null = null;
  if (one(params.confirm) === "1") {
    const place = { label: one(params.label), lat: Number(one(params.lat)), lon: Number(one(params.lon)) };
    if (!homeProblem({ ...place, radiusMiles })) {
      const estimate = estimatePull(db, { ...place, radiusMiles });
      if (estimate.kind === "new") confirm = { place, estimate };
    }
  }

  return (
    <>
      <h1>Settings</h1>
      <h2 className="section-title">Location</h2>
      <CurrentHome home={home} />

      {one(params.saved) === "1" && <p className="notice">Saved. Concerts and Suggestions now use this location.</p>}
      {one(params.problem) && <p className="notice">That location didn&apos;t work: {one(params.problem)}.</p>}

      <form action={chooseHome} className="radius-form">
        <input type="hidden" name="label" value={home.label} />
        <input type="hidden" name="lat" value={home.lat} />
        <input type="hidden" name="lon" value={home.lon} />
        <RadiusPicker current={home.radiusMiles} />
        <button type="submit" className="small-button">Update radius</button>
      </form>

      <h2 className="section-title">Move home</h2>
      <form action="/settings" className="search">
        <input name="q" defaultValue={q} placeholder="City or address, or lat, lon" aria-label="City or address" />
        <select name="r" defaultValue={Math.round(radiusMiles)} aria-label="Radius">
          {RADIUS_PRESETS.map((r) => (
            <option key={r} value={r}>
              {r} mi
            </option>
          ))}
        </select>
        <button type="submit">Search</button>
      </form>
      <UseMyLocation radiusMiles={radiusMiles} />

      {searchFailed && (
        <p className="notice">
          The place search didn&apos;t answer ({searchFailed}). Try again in a moment, or type coordinates
          like <code>42.33, -83.05</code>.
        </p>
      )}
      {q && !searchFailed && places.length === 0 && <p className="notice">No places found for “{q}”.</p>}
      {places.length > 0 && <Results db={db} places={places} radiusMiles={radiusMiles} />}

      <p className="meta" style={{ marginTop: "1.5rem" }}>
        A smaller radius, or a move back to an area pulled before, uses shows already stored. A new area
        needs a pull from JamBase, and you&apos;ll see what it costs before it starts.{" "}
        {areaCallsLeft(db)} area calls are left this month. Place search by{" "}
        <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>.{" "}
        <Link href="/concerts">Back to Concerts</Link>
      </p>

      {confirm && <CostWarning place={confirm.place} radiusMiles={radiusMiles} estimate={confirm.estimate} left={areaCallsLeft(db)} />}
    </>
  );
}
