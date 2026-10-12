"use client";

import { useRef, useState } from "react";
import { chooseHome } from "../actions";

/** Asks the browser where you are, then sets home there. */
export function UseMyLocation({ radiusMiles }: { radiusMiles: number }) {
  const form = useRef<HTMLFormElement>(null);
  const lat = useRef<HTMLInputElement>(null);
  const lon = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<"idle" | "asking" | "failed">("idle");

  const locate = () => {
    if (!("geolocation" in navigator)) return setState("failed");
    setState("asking");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        lat.current!.value = pos.coords.latitude.toFixed(4);
        lon.current!.value = pos.coords.longitude.toFixed(4);
        form.current!.requestSubmit();
      },
      () => setState("failed"),
      { timeout: 15000, maximumAge: 10 * 60 * 1000 },
    );
  };

  return (
    <form ref={form} action={chooseHome} className="locate">
      <input ref={lat} type="hidden" name="lat" />
      <input ref={lon} type="hidden" name="lon" />
      <input type="hidden" name="r" value={radiusMiles} />
      <button type="button" className="small-button" onClick={locate} disabled={state === "asking"}>
        {state === "asking" ? "Finding you…" : "Use my location"}
      </button>
      {state === "failed" && (
        <span className="meta"> The browser didn&apos;t share a location. Search for a city instead.</span>
      )}
    </form>
  );
}
