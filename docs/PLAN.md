# bandwagon: data sources, MVP plan, and roadmap

_Drafted 2026-10-09, updated the same day after the JamBase test. Pricing and terms were read from each provider's public pages on that date; items marked "unverified" still need checking once we have API keys._

## The idea

You type a band you love. bandwagon finds the artists who have shared a bill with that band (opened for them, headlined over them, toured with them, played the same small show) and recommends them, ranked by how strong the connection is.

---

## 1. Data sources

What we need from a source:

1. **Disambiguation**: given "Low" or "Nirvana", return a list of candidate artists with enough context (country, years active, genre, a short note) to let the user pick the right one, and a stable ID.
2. **Co-billing**: for a given artist, which other artists played the same event, ideally with headliner vs. support roles and tour names.
3. **History**: past shows would be ideal, since years of touring hold the most signal. For now we use upcoming shows (see the decision below).
4. **Terms we can live with**: free or cheap for a hobby/MVP, with no ban on our use case.

### Summary

| Source | Disambiguation | Co-billing / lineups | Past shows | Cost and access | Fit for MVP |
|---|---|---|---|---|---|
| **setlist.fm API** | Artist search keyed on MusicBrainz IDs | Indirect: query setlists by venue and date to find everyone who played that show. Setlists carry a tour name. | Yes, deep and crowd-sourced | Free API key, **non-commercial only**. No storage beyond short-term caching. Attribution link required. | Too sparse for small bands (see below) |
| **MusicBrainz** | Excellent: every artist has a `disambiguation` comment, type, country, area, life span, tags | Has an Event entity, but concert coverage is sparse | Sparse | Free for non-commercial use, 1 request/second, User-Agent required. Core data is downloadable for self-hosting. | **Primary disambiguation and ID backbone** |
| **JamBase Data API** (named by you) | Artist search; artists map to third-party IDs | Yes, events list one or more performers | Free tier: **future events only**, 6-month window. Past events start at Pro ($1,500/mo, 3 years). Full history at Pro+ ($2,500/mo). | Free Developer tier is 1,000 calls/month, non-commercial, attribution required. 14-day trial on paid tiers. | **Primary co-billing source (upcoming shows).** Lists openers well when venues announce them; see the test below. |
| **Songkick API** (named by you) | Artist search | Event details and full artist gigography | Yes | **Paid license only.** Songkick states it is not approving student, educational, or hobbyist requests. | Not available to us for now |
| **Bandsintown API** | By name or ID | Event results include the lineup | Yes, past and upcoming | Meant for artists and people working on their behalf. Others must email a proposal with traffic projections. Student and educational projects are not accepted. | Unlikely to be approved for now |
| **Ticketmaster Discovery API** | Attraction search | Events embed their list of attractions (unverified for how often support acts are listed) | Mostly upcoming | Free key, 5,000 calls/day, 5 requests/second | Optional supplement for upcoming co-bills |
| **Wikidata** | Good: links MusicBrainz, Spotify, setlist.fm, Songkick and Discogs IDs on one item | Tours exist as items, but opening-act data is thin and inconsistent | Patchy | Free, CC0 | ID crosswalk only, useful for the Spotify roadmap item |
| **Spotify Web API** | Search works | No live data | No | **Related Artists and Recommendations were cut off for new apps in Nov 2024.** Since Feb 2026, Development Mode requires a Premium account, allows 5 users per app, and exposes a reduced set of endpoints. | Roadmap only (import a user's top artists); see the roadmap |

### What this means

- **No free source hands us years of "artists who shared a stage with X".** The paid sources (Songkick, JamBase Pro, Bandsintown) come closest, and they are either closed to hobby projects or cost $1,500+ a month.
- **setlist.fm was the first candidate but is too sparse for our target bands.** It is crowd-sourced, and fans rarely log setlists for smaller or newer acts, which are exactly the bands bandwagon is meant to surface. Spot checks of "same venue, same date" found large gaps.
- **Decision (2026-10-09): build on upcoming shows, starting with JamBase's free tier.** Ticket listings name the supporting acts, so they don't depend on fans logging anything. See the test results below.

### JamBase opener test (2026-10-09)

We ran `jambase_test.py` against five smaller bands on the free tier (10 API calls). Each JamBase event lists its performers with a headliner flag (`x-isHeadliner`) and billing order (`x-performanceRank`).

| Band | Upcoming events | Festivals | Concerts with other acts on the bill |
|---|---|---|---|
| Cowboy Hunters | 8 | 2 | 2 |
| Ecca Vandal | 14 | 5 | 0 |
| Harrison Gordon | 7 | 0 | 3 |
| Telescreens | 9 | 0 | 0 |
| Prince Daddy & The Hyena | 25 | 0 | 21 |

- Openers are listed when the venue or promoter lists them. 26 of 56 non-festival shows had at least one other act.
- Coverage is uneven: one touring band carried most of the co-bills, and two bands had none outside festivals. Some bands simply have no co-billed shows announced yet, so results will be thin for them on any given day.
- **Festivals are dropped as a signal** (decided 2026-10-09). Their lineups are huge, and sharing one says little about two bands' connection.

### The MVP data path

1. **Disambiguation via MusicBrainz.** Search the typed name and show candidates with their disambiguation note. The user picks one, giving us an MBID.
2. **Upcoming bills via JamBase.** Call `/v3/events?artistId=musicbrainz:<mbid>` (JamBase accepts MusicBrainz IDs, per its API spec; to verify), falling back to a JamBase artist search by name. One call returns all upcoming events with their performers.
3. **Keep concerts, drop festivals.** Every other performer on a concert bill is a co-billed artist.

One API call per lookup fits the free tier's 1,000 calls a month for an MVP, with caching.

### Costs and open questions

- _Coverage_: limited to announced shows in the next 6 months. A band between tours returns nothing. Mitigation: collect forward (below).
- _Quota_: 1,000 calls/month on the free tier, 5¢ per extra call. Cache aggressively and avoid repeat lookups.
- _Terms_: the free tier is non-commercial and requires attribution. **JamBase's rules on storing data are not yet checked**, and the "collect forward" idea depends on them.
- _Supplements_: Ticketmaster Discovery for big venues, and a venue-calendar crawler for indie rooms (for example, First Avenue lists "with X" supports and tour names), if JamBase coverage proves too thin.

### Collect forward

If we check upcoming bills regularly and keep what we find, after a few months we have the touring history we can't afford to buy. This needs a source whose terms allow storage (JamBase's are unchecked; Ticketmaster allows only "reasonable periods"; venue sites vary).

---

## 2. MVP: one band in, recommendations out

### User flow

1. A single search box: "Type a band you love."
2. A disambiguation list from MusicBrainz: name, disambiguation note, type (group/person), country, years active, top tags. For example: "Low (American slowcore band, Duluth, 1993–2022)" vs. other artists called Low.
3. The user picks one. A results page shows ranked recommendations, each with **why**: (illustrative) "Opening for [your band] on 6 dates this fall."
4. Each recommendation links out (the JamBase event, with attribution as the terms require, MusicBrainz, and later Spotify).

### Ranking (first pass)

Score each co-billed artist by summing over shared upcoming concerts:

- **Shared show count** is the core signal. Several dates together means a tour support slot, the strongest link.
- **Billing relationship**: use `x-isHeadliner` and `x-performanceRank` to say "opening for" vs. "headlining over" in the explanation, and optionally weight direct support slots higher.
- **Lineup size penalty**: a 3-act bill is a stronger link than an 8-act one. Weight each show by something like `1 / (number of acts − 1)`.
- **No festivals** (decided).
- **Exclude** the seed artist and duplicates.

This is a heuristic to tune by eye against bands we know well. No machine learning in the MVP.

### Architecture (default choice, open to change)

- **Next.js (TypeScript)** for both the UI and the server routes, deployed to one host such as Vercel. Server routes keep API keys off the client.
- **Server-side clients** for MusicBrainz (1 req/s queue, proper User-Agent) and JamBase (Bearer key, quota tracking).
- **Cache** JamBase responses per artist for a day or so, within its terms once checked, to protect the monthly quota. MusicBrainz lookups can be cached freely.

### MVP milestones

1. ~~**Spike**: test whether the source lists openers for small bands.~~ Done for JamBase; see the test results above.
2. **Disambiguation UI**: search box plus MusicBrainz candidate picker.
3. **Co-bill engine**: JamBase lookup by MBID, festival filter, scoring, caching.
4. **Results page**: ranked list with the "why" text and required attribution.
5. **Deploy**, then share with a few friends for feedback.

### Before we build

- Read JamBase's terms on caching and storage, and its attribution rules.
- Confirm that `artistId=musicbrainz:<mbid>` works on the free tier.
- Plan for the key: the trial key expires after 14 days, so move to the free Developer key and keep it in an environment variable, never in the repo.

---

## 3. Roadmap

### Near term

- **Thin-results fallback**: when a band has no co-billed shows announced, say so clearly and suggest trying a related band.
- **Better coverage of openers**: Ticketmaster attractions for large venues, and a venue-calendar crawler for indie rooms in a few cities.
- **Collect forward**: store co-bills daily (if terms allow) to build our own history.
- **Filters**: limit to a date range or region, show only support acts or only headliners.

### Many bands in, a network out

- Accept a list of favourite bands. Run the co-bill engine on each, then rank candidates by how many of your favourites they connect to and how strongly. An artist who tours with three of your favourites outranks one who tours with one of them many times.
- **Graph view**: favourites as seeds, recommended artists as nodes, edges weighted by shared shows. A force-directed layout (for example D3 or Sigma.js) lets you explore second-degree connections ("touring with someone who toured with your favourite").
- **Data constraint**: a persistent graph needs stored co-billing data, which depends on the storage terms of whichever source we use. Upcoming-only data also makes the graph sparse until "collect forward" has run for a while.

### Spotify integration

- **Input**: sign in with Spotify and import your top or followed artists as seeds, instead of typing them. Map Spotify artist IDs to MusicBrainz IDs through MusicBrainz URL relationships or Wikidata.
- **Output**: link recommendations to Spotify, and optionally build a playlist of top tracks from recommended artists.
- **Constraints to plan for**: since February 2026, Spotify Development Mode needs a Premium account on the developer side, allows only 5 authorized users per app, and limits available endpoints. Opening it to the public needs Spotify's extended quota approval. Related Artists and Recommendations are unavailable to new apps, which is fine, because bandwagon's recommendations come from live-show data, not Spotify's.

### Later ideas

- Explain each link with show details (date, venue, who headlined).
- "Discover by venue": artists who play the small rooms your favourites play.
- Accounts and saved networks.

---

## Sources

- JamBase Data API: <https://data.jambase.com/>, pricing <https://data.jambase.com/pricing>
- Songkick developer: <https://www.songkick.com/developer>
- setlist.fm API docs: <https://api.setlist.fm/docs/1.0/index.html>, terms <https://www.setlist.fm/help/terms>
- MusicBrainz API: <https://musicbrainz.org/doc/MusicBrainz_API>, Event entity <https://musicbrainz.org/doc/Event>
- Bandsintown API access policy: <https://help.artists.bandsintown.com/en/articles/3372745-can-i-have-access-to-the-api-and-an-app-id-if-i-m-not-an-artist>
- Ticketmaster Discovery API: <https://developer.ticketmaster.com/products-and-docs/apis/getting-started/>
- Spotify Web API changes: <https://developer.spotify.com/blog/2024-11-27-changes-to-the-web-api>, <https://developer.spotify.com/blog/2026-02-06-update-on-developer-access-and-platform-security>
