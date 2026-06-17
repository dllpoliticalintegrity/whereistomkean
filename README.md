# Where is Tom Kean?

A standalone, single-page accountability site. It shows:

1. **A live "missing" counter** ticking up (days : hours : minutes : seconds) since
   **March 5, 2025** — Rep. Thomas Kean Jr.'s (NJ-07) last confirmed in-person town hall.
2. **Every disclosed stock trade** he has made, pulled live from the same Supabase
   database that powers [Integrity Index](https://integrityindex.us), newest first.

The whole site is a single `index.html` — no build step, no framework, no
dependencies. It talks directly to Supabase from the browser using the public
anon key.

Files (all at the repo root):

- `index.html` — the entire site
- `og-image.png` — 1200×630 social share card
- `robots.txt`, `sitemap.xml` — crawlability

## Run locally

Any static file server works:

```sh
npx serve .
# or: python3 -m http.server
```

A server is only needed so the ES module import resolves cleanly (opening the
file directly also works in most browsers).

## Deploy (Cloudflare Pages)

Production domain: **https://whereistomkean.org**

1. Cloudflare Pages → Create project → Connect to Git → this repo.
2. **Build command:** *(empty)* · **Build output directory:** `/` · **Root directory:** `/`
   (it's pre-built static files — nothing to compile).
3. Custom domains → add `whereistomkean.org` (DNS + HTTPS provision automatically
   if the domain's nameservers are on Cloudflare).

Netlify/Vercel work the same way: no build command, serve the repo root.

> The canonical URL, `og:url`, `sitemap.xml`, and `robots.txt` all hard-code
> `https://whereistomkean.org`. If the domain changes, update those four spots.

After the first deploy, prime the social caches once via the
[Facebook Sharing Debugger](https://developers.facebook.com/tools/debug/) and
[X Card Validator](https://cards-dev.twitter.com/validator) so shared links show
the card immediately.

## Configuration

All knobs live in the `Config` block at the top of the `<script type="module">`
in `index.html`:

- `MISSING_SINCE` — the "last sighting" date the counter counts up from.
- `CANDIDATE_SLUG` / `CANDIDATE_BIOGUIDE` — who is tracked (`thomas-kean` / `K000398`).
- `SUPABASE_URL` / `SUPABASE_ANON_KEY` — the database connection.

### About the anon key

The embedded `SUPABASE_ANON_KEY` is the project's **public** key (the same one the
Integrity Index app ships to every browser). It is safe to expose; the database is
protected by Supabase Row Level Security, so only public, read-only data is reachable.

## Data

Trades come from the `congress_trades` table (joined to `candidates` via
`bioguide_id`). Amounts are self-reported disclosure ranges under the STOCK Act;
the displayed dollar figure is the midpoint of the disclosed range. Near-duplicate
disclosure rows for the same trade are collapsed client-side.
