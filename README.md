# bandwagon

Type a band you love, and bandwagon recommends the artists sharing upcoming bills with them: their openers, the bands they open for, and their tourmates. See [docs/PLAN.md](docs/PLAN.md) for the data sources, MVP plan, and roadmap.

## How it works

1. **Pick the band.** The search box queries [MusicBrainz](https://musicbrainz.org) and lists every artist with that name, with the disambiguation note, area, years active, and top tags, so you can pick the right "Low".
2. **Find shared bills.** The server asks the [JamBase Data API](https://data.jambase.com) for that artist's upcoming events by MusicBrainz ID, falling back to a JamBase name search matched on the MusicBrainz link.
3. **Rank.** Festivals and cancelled shows are dropped. Every other act on a concert bill earns `1 / (acts on the bill − 1)` per shared show, so a run of tour dates on a small bill ranks highest. Each result says why ("Opening for X on 6 dates").

When a band has nothing announced, or its shows list no other acts yet, the results page says so instead of showing an empty list.

## Running it

Needs Node 20.9 or newer (`.nvmrc` pins 22, so `nvm use` picks it up).

```bash
npm install
cp .env.example .env.local   # then add your JamBase key
npm run dev                  # http://localhost:3000
```

`JAMBASE_API_KEY` is read on the server only. Never commit it.

## Checks

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

## Code map

- `src/lib/musicbrainz.ts`: artist search and lookup, throttled to MusicBrainz's 1 request/second.
- `src/lib/jambase.ts`: upcoming events by MusicBrainz ID, with the name-search fallback.
- `src/lib/cobills.ts`: festival filter, scoring, and the "why" text. Pure functions, unit tested.
- `src/lib/recommend.ts`: ties the two together and decides which empty state to show.
- `src/app/`: the search page (`page.tsx`) and the results page (`artist/[mbid]/page.tsx`).

Responses are cached in memory only (JamBase for a day, MusicBrainz for a week). Nothing is written to disk until JamBase's storage terms are checked.
