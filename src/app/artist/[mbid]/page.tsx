import { redirect } from "next/navigation";
import { bandsHref, idsFrom } from "@/lib/picks";

/** Old single-band results URL; the results page now takes several bands. */
export default async function ArtistPage({ params }: PageProps<"/artist/[mbid]">) {
  const ids = idsFrom((await params).mbid);
  redirect(ids.length ? bandsHref(ids) : "/");
}
