import Link from "next/link";
import type { SavedHome } from "@/lib/home";

/** "Near Detroit, 100 mi · Change", linking to the Settings page. */
export function NearLine({ home }: { home: SavedHome }) {
  return (
    <span className="near-line">
      Near {home.label}, {Math.round(home.radiusMiles)} mi · <Link href="/settings">Change</Link>
    </span>
  );
}
