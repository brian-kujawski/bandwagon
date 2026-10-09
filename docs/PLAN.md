# bandwagon: data sources, MVP plan, and roadmap

_Drafted 2026-10-09. Pricing and terms were read from each provider's public pages on that date; items marked "unverified" still need checking once we have API keys._

## The idea

You type a band you love. bandwagon finds the artists who have shared a bill with that band (opened for them, headlined over them, toured with them, played the same small show) and recommends them, ranked by how strong the connection is.

---

## 1. Data sources

What we need from a source:

1. **Disambiguation**: given "Low" or "Nirvana", return a list of candidate artists with enough context (country, years active, genre, a short note) to let the user pick the right one, and a stable ID.
2. **Co-billing**: for a given artist, which other artists played the same event, ideally with headliner vs. support roles and tour names.
3. **History**: past shows, not just upcoming ones. Most of the signal is in years of touring history.
4. **Terms we can live with**: free or cheap for a hobby/MVP, with no ban on our use case.

### Summary

| Source | Disambiguation | Co-billing / lineups | Past shows | Cost and access | Fit for MVP |
|---|---|---|---|---|---|
| **setlist.fm API** | Artist search keyed on MusicBrainz IDs | Indirect: query setlists by venue and date to find everyone who played that show. Setlists carry a tour name. | Yes, deep and crowd-sourced | Free API key, **non-commercial only**. No storage beyond short-term caching. Attribution link required. | **Primary co-billing source** |
| **MusicBrainz** | Excellent: every artist has a `disambiguation` comment, type, country, area, life span, tags | Has an Event entity, but concert coverage is sparse | Sparse | Free for non-commercial use, 1 request/second, User-Agent required. Core data is downloadable for self-hosting. | **Primary disambiguation and ID backbone** |
| **JamBase Data API** (named by you) | Artist search; artists map to third-party IDs | Yes, events list one or more performers | Free tier: **future events only**, 6-month window. Past events start at Pro ($1,500/mo, 3 years). Full history at Pro+ ($2,500/mo). | Free Developer tier is 1,000 calls/month, non-commercial, attribution required. 14-day trial on paid tiers. | Good for "who is touring together right now" on the free tier. History is too expensive for an MVP. |
| **Songkick API** (named by you) | Artist search | Event details and full artist gigography | Yes | **Paid license only.** Songkick states it is not approving student, educational, or hobbyist requests. | Not available to us for now |
| **Bandsintown API** | By name or ID | Event results include the lineup | Yes, past and upcoming | Meant for artists and people working on their behalf. Others must email a proposal with traffic projections. Student and educational projects are not accepted. | Unlikely to be approved for now |
| **Ticketmaster Discovery API** | Attraction search | Events embed their list of attractions (unverified for how often support acts are listed) | Mostly upcoming | Free key, 5,000 calls/day, 5 requests/second | Optional supplement for upcoming co-bills |
| **Wikidata** | Good: links MusicBrainz, Spotify, setlist.fm, Songkick and Discogs IDs on one item | Tours exist as items, but opening-act data is thin and inconsistent | Patchy | Free, CC0 | ID crosswalk only, useful for the Spotify roadmap item |
| **Spotify Web API** | Search works | No live data | No | **Related Artists and Recommendations were cut off for new apps in Nov 2024.** Since Feb 2026, Development Mode requires a Premium account, allows 5 users per app, and exposes a reduced set of endpoints. | Roadmap only (import a user's top artists); see section 4 |

### What this means

- **No free source hands us "artists who shared a stage with X" directly.** The paid sources (Songkick, JamBase Pro, Bandsintown) come closest, and they are either closed to hobby projects or cost $1,500+ a month.
- **The free path is MusicBrainz + setlist.fm.** setlist.fm keys artists on MusicBrainz IDs, so the two connect cleanly:
  1. Search MusicBrainz for the typed name. Show candidates with their disambiguation text. The user picks one, giving us an MBID.
  2. Fetch that artist's setlists from setlist.fm (`/1.0/artist/{mbid}/setlists`). Each setlist has a venue ID, a date, and often a tour name.
  3. For each (venue, date), call `/1.0/search/setlists?venueId=…&date=…` to list every artist with a setlist at that show. Those are the co-billed artists.
- **Costs to plan around with setlist.fm:**
  - _Coverage bias_: crowd-sourced, so headliners are covered far better than openers. An opener with no setlist entry is invisible. This is the biggest data-quality risk.
  - _Call volume_: step 3 is one call per show. An artist with 1,000 shows means 1,000+ calls. setlist.fm reserves the right to rate-limit, and the exact limits are unverified. The MVP should cap at the most recent N shows (say 100–200) and fetch progressively.
  - _Storage_: the terms forbid keeping setlist.fm data beyond short-term caching, so we cannot build a permanent co-billing database from it. We can cache per request for a short time. A long-lived graph (roadmap) needs a source whose terms allow storage, or explicit permission from setlist.fm.
  - _Non-commercial_: fine for now. If bandwagon ever earns money, we need a setlist.fm agreement or a paid source.
- **JamBase's free tier is a useful second signal**: "these bands are on the same upcoming bill." It is a small monthly quota (1,000 calls), so use it sparingly and cache.

---

## 2. MVP: one band in, recommendations out

### User flow

1. A single search box: "Type a band you love."
2. A disambiguation list from MusicBrainz: name, disambiguation note, type (group/person), country, years active, top tags. For example: "Low (American slowcore band, Duluth, 1993–2022)" vs. other artists called Low.
3. The user picks one. A results page shows ranked recommendations as they load, each with **why**: "Shared 7 bills with Low, 2018–2021, including the _Double Negative_ tour."
4. Each recommendation links out (MusicBrainz, setlist.fm attribution links as the terms require, and later Spotify).

### Ranking (first pass)

Score each co-billed artist by summing over shared shows:

- **Shared show count** is the core signal.
- **Lineup size penalty**: a show with 3 acts is a strong link; a festival with 120 acts is nearly meaningless. Weight each show by something like `1 / (number of acts − 1)`, or drop events with more than about 10 acts.
- **Tour bonus**: repeated co-billing under the same tour name means a tour support slot, the strongest signal.
- **Recency**: gently favour recent shows.
- **Exclude** the seed artist and obvious duplicates (same MBID).

This is a heuristic to tune by eye against bands we know well. No machine learning in the MVP.

### Architecture (default choice, open to change)

- **Next.js (TypeScript)** for both the UI and the server routes, deployed to one host such as Vercel. Server routes keep API keys off the client and enforce rate limits.
- **Server-side clients** for MusicBrainz (1 req/s queue, proper User-Agent) and setlist.fm (key in header, request queue, backoff on 429).
- **Short-lived cache** (in-memory or a small KV store) for setlist.fm responses, within its "short-term caching" terms. MusicBrainz lookups can be cached freely.
- **Streaming results**: compute in the background and stream partial rankings to the page, because a cold lookup may take tens of seconds at polite rate limits.

### MVP milestones

1. **Spike** (throwaway script): for 3–5 bands we know well, run the MusicBrainz → setlist.fm pipeline, eyeball the co-bill lists, and measure call counts and how many openers are missing. This validates the core idea before building any UI.
2. **Disambiguation UI**: search box plus MusicBrainz candidate picker.
3. **Co-bill engine**: setlist.fm fetch, venue/date fan-out, scoring, caching.
4. **Results page**: ranked list with the "why" text and required attribution.
5. **Deploy**, then share with a few friends for feedback.

### Before we build

- Request a **setlist.fm API key** (free, from a logged-in setlist.fm account settings page). Only you can do this.
- Optionally start a **JamBase free Developer key** to test the upcoming-bills signal.
- Confirm setlist.fm's actual rate limits once we have a key.

---

## 3. Roadmap

### Near term

- **Upcoming co-bills** via JamBase (free tier) or Ticketmaster: "Also touring with Low this year."
- **Better coverage of openers**: merge in MusicBrainz event data, and Ticketmaster attractions for upcoming shows.
- **Filters**: exclude festivals, limit to a date range, only show support acts / only show headliners.

### Many bands in, a network out

- Accept a list of favourite bands. Run the co-bill engine on each, then rank candidates by how many of your favourites they connect to and how strongly. An artist who toured with three of your favourites outranks one who toured with one of them many times.
- **Graph view**: favourites as seeds, recommended artists as nodes, edges weighted by shared shows. A force-directed layout (for example D3 or Sigma.js) lets you explore second-degree connections ("toured with someone who toured with your favourite").
- **Data constraint**: a persistent graph needs stored co-billing data. setlist.fm terms do not allow that, so this phase needs either written permission from setlist.fm, a paid license (JamBase Pro/Pro+, Songkick), or a source whose terms allow storage. Decide this before starting the phase.

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
