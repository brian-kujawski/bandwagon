# bandwagon

Like the bands you love, as many as you want, and bandwagon recommends the artists sharing bills with them (their openers, the bands they open for, their tourmates) and the artists one step further out, who those tourmates play with on other dates. See [docs/PLAN.md](docs/PLAN.md) for the data sources, MVP plan, and roadmap.

## How it works

1. **Like your bands.** The search box queries [MusicBrainz](https://musicbrainz.org) and lists every artist with that name, with the disambiguation note, area, years active, and top tags, so you can like the right "Low". There is no cap, and `node scripts/data.mts like <file>` likes a whole list at once. Mark bands "Not interested" to keep them out of results; they can still connect two bands you like.
2. **Collect their shows.** Each visit to the results page asks the [JamBase Data API](https://data.jambase.com) for the upcoming events of a few liked bands that haven't been checked for a month (`BANDWAGON_REFRESH_PER_VISIT`, default 5), by MusicBrainz ID with a name-search fallback, and stores every concert bill in a local SQLite database. Festivals are left out.
3. **Widen the web.** The top five directly linked acts get their own upcoming shows looked up too (one JamBase call each, re-checked at most monthly), so the database learns who *they* play with.
   - Every JamBase call is counted, and the app stops at `JAMBASE_MONTHLY_BUDGET` calls a month (default 900, under the free tier's 1,000). The results page shows the month's count.
4. **Rank.** Each shared concert date adds `1 / (acts on the bill − 1)` to the link between two acts, so a run of tour dates on a small bill counts most. Upcoming dates count 1.25 times a past date, since the point is shows to go and see.
   - Each link to one of your bands counts `1 − e^−w` for its summed weight `w`, so it tops out near 1: links to several of your bands beat many dates with one, and one slot on a huge bill counts for little. Each result says why ("Opening for X on 6 upcoming dates").
   - One step further: an act also gets credit for sharing a bill, on a date none of your bands played, with one of your strongest direct links (the top 2,000). Each such link passes on half its own score, divided by the square root of how many acts it has played with, so an act that has played with everyone spreads its credit thinner.
   - Both add into one score and one list, so an act two steps from all of your bands can rank above one that shared a single big bill with one of them.
   - Scores for every artist are stored and recomputed only when your bands or the stored shows change, and once a day as shows move from upcoming to past; results come 25 to a page. A synthetic graph of 100,000 artists, 300,000 shows and 10,000 liked bands took about 10 s to rescore after new shows, under 2 s after liking a band, and about 0.2 s per results page.

Because everything lands in one database, Concert Archives history (from the vault, below) links up with JamBase shows by artist name, and every search makes the web a little bigger.

## Running it

Needs Node 22.13 or newer for the built-in `node:sqlite` (`.nvmrc` pins 22, so `nvm use` picks it up). Node prints an "SQLite is an experimental feature" warning once at startup; it is harmless.

```bash
npm install
cp .env.example .env.local   # then add your JamBase key
npm run dev                  # http://localhost:3000
```

`JAMBASE_API_KEY` is read on the server only. Never commit it.

The database lives at `data/bandwagon.db` (git-ignored); set `BANDWAGON_DB` to move it, or to `:memory:` to keep nothing. Without a JamBase key the app still runs on whatever is already stored.

## Checks

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

## Code map

- `src/lib/musicbrainz.ts`: artist search and lookup, throttled to MusicBrainz's 1 request/second.
- `src/lib/jambase.ts`: upcoming events by MusicBrainz ID (with the name-search fallback) or by JamBase ID.
- `src/lib/db.ts`: the SQLite store. Tables `artists`, `events`, `appearances` (who played which event, with billing), `fetches` (when each artist was last pulled), and the `cobills` view (one row per pair of acts per shared date, with its weight). Artists match across sources by MusicBrainz, JamBase or Concert Archives ID, or by a unique name.
- `src/lib/ingest.ts`: writes JamBase events and Concert Archives summaries into the store.
- `src/lib/vault.ts`: every paid parse.bot response, kept verbatim in the `payloads` table, and the Concert Archives concert and performer ledgers rebuilt from it.
- `src/lib/prefs.ts`: liked and not-interested bands, keyed by MusicBrainz ID, plus bulk liking from a list.
- `src/lib/budget.ts`: monthly API call counts per machine, and the JamBase budget.
- `src/lib/portable.ts`: export and merge-import of the vault, your band choices and call counts between machines.
- `src/lib/graph.ts`: direct and 2-hop scores for every artist, stored in `affinity` and read a page at a time, and the "why" text. Unit tested against an in-memory database.
- `src/lib/recommend.ts`: refreshes a few liked bands per visit and the top neighbours (monthly, within the budget), then ranks.
- `src/lib/cobills.ts`: JamBase event helpers (seed detection, billing relation, venue).
- `src/lib/concertArchives.ts`: turns Concert Archives concert lists into co-bills (lineups from show titles, festival filter, de-duplication).
- `src/app/`: band search and your saved bands (`page.tsx`), the results page (`bands/page.tsx`), and the like / not-interested server action (`actions.ts`). Old `/artist/<mbid>` links redirect home.

JamBase's storage terms are still unchecked, so the database is for local, non-commercial experimenting. Don't deploy it publicly or share the file until they are.

### Exploring the database

`scripts/graph.mts` works on the stored data only, with no API calls:

```bash
node scripts/graph.mts links PUP "Prince Daddy & The Hyena"   # direct and one-step links
node scripts/graph.mts stats
```

## Concert Archives history (experimental)

`scripts/concert-archives.mts` pulls a band's past shows from Concert Archives through a parse.bot subscription to the marketplace "concertarchives.org API", then tallies who shared a bill. It is a personal, non-commercial experiment; Concert Archives' terms restrict reuse without permission, so its output stays local.

```bash
PARSE_API_KEY=pmx_... PARSE_SCRAPER_ID=<your scraper id> \
  node scripts/concert-archives.mts pup--5 --name PUP --max-pages 3 --budget 10
```

The slug is the one in the band's Concert Archives URL. Each page of about 50 rows costs 2 credits; show titles carry the lineup, so the script never pays for per-concert detail calls. Every response goes into the database's vault and into `data/concert-archives/raw/` (git-ignored); a page either one holds is never fetched again, and the script stops before going over `--budget` credits.

## Keeping what you paid for

Paid responses live in the `payloads` table and are never deleted. Concert Archives shows in the graph are rebuilt from them, so nothing bought is lost when the parser changes. `scripts/data.mts` looks after them, with no API calls:

```bash
node scripts/data.mts import-raw           # add pages cached in data/concert-archives/raw before the vault existed
node scripts/data.mts status               # per band: pages held, date range, credits spent, whether history is complete
node scripts/data.mts rebuild              # re-derive Concert Archives shows from the vault
node scripts/data.mts export               # write bandwagon-export.sqlite
node scripts/data.mts import <file>        # merge an export from another machine
node scripts/data.mts like bands.txt       # like every band in a list (one per line, or a CSV's first column)
```

Exports carry the vault, your liked and not-interested bands, and the month's JamBase call counts. To move between machines (Windows and Linux both work), run `export` on one, copy the file over (USB stick, a cloud drive, anything), and run `import` on the other. Import merges (for a band you changed on both machines, the newer choice wins), so working on both machines loses nothing, and importing the same file twice is harmless. Copy the export, not `data/bandwagon.db` itself: a copy of the live database taken while the app runs can miss recent writes. Exports are git-ignored; keep them out of GitHub, since Concert Archives' terms restrict sharing.
