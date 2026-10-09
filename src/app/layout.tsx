import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "bandwagon",
  description: "Find bands through who they share a stage with.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body>
        <header className="site-header">
          <Link href="/" className="wordmark">
            bandwagon
          </Link>
        </header>
        <main>{children}</main>
        <footer className="site-footer">
          Concert data from <a href="https://www.jambase.com">JamBase</a>. Artist data from{" "}
          <a href="https://musicbrainz.org">MusicBrainz</a>.
        </footer>
      </body>
    </html>
  );
}
