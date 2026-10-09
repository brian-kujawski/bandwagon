import { redirect } from "next/navigation";

/** Old single-band results URL; results now come from the bands you've liked. */
export default function ArtistPage() {
  redirect("/");
}
