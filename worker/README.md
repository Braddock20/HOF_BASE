# tiktok-scraper Worker (Cloudflare)

A Cloudflare Worker that collects **public** TikTok video and creator-profile
metadata and returns it as JSON or CSV.

It is the edge-hosted half of the project: the Python tool
(`tiktok_scraper/`) does hashtag discovery with a real browser, and this
Worker turns any list of video URLs or creator handles into a clean dataset —
with the exact same column names, so both can be pooled into one CSV.

> **Note on layout:** `wrangler.toml`, `package.json` and `tsconfig.json` live
> at the **repository root**, not in `worker/`. Cloudflare's build system runs
> `npx wrangler deploy` from the repo root, so wrangler must find its config
> there — otherwise it fails with *"Could not detect a directory containing
> static files"*. Only the TypeScript source lives in `worker/src/`.

---

## Quick start

```bash
# from the repository root
npm install
npm run dev            # local dev server on http://127.0.0.1:8787
```

```bash
npm run deploy         # publish to *.workers.dev
# or, with a smoke test of the live URL afterwards:
./scripts/deploy.sh
```

> `wrangler.toml` must contain the name of the worker you already have live
> (`name = "hof"` for `hof.talesapi.workers.dev`). A different name publishes
> a second, empty worker instead of updating yours.

You need a free Cloudflare account and to be logged in:

```bash
npx wrangler login
```

---

## Deploying from Cloudflare's dashboard

In **Workers & Pages → your Worker → Settings → Builds**, set:

| Field | Value |
| --- | --- |
| Build command | `npm run deploy` |
| Install command | `npm install` |
| Root directory | `/` (repo root) |

If you leave the install command blank, Cloudflare auto-detects the Python
`requirements.txt` in this repo and installs pandas/matplotlib/playwright —
about 90 seconds you do not need. Setting it to `npm install` skips that.

**Before your first push**, run the pre-flight check from the repository
root. It performs the same steps the Cloudflare build performs:

```bash
./scripts/preflight.sh
```

If it reports that `npm ci` cannot install because the lock file is out of
sync, your repo's `package.json` and `package-lock.json` describe different
dependency sets. Fix it with `./scripts/sync-lockfile.sh` (rebuilds the lock
file from your `package.json`, leaving your dependencies alone),
`./scripts/reset-deps.sh` (restore this project's lean dependency set), or by
setting the dashboard install command to `npm install` instead of `npm ci`.

Check the build log for:

```
Total Upload: 21.67 KiB / gzip: 6.24 KiB
```

That means the Worker bundled correctly.

---

## Endpoints

| Endpoint | What it does |
| --- | --- |
| `GET /` | service description and usage |
| `GET /api/health` | liveness probe (returns the colo it ran in) |
| `GET /api/video?url=<video url>` | one video's metadata |
| `GET /api/profile?handle=<handle>` | one creator's public profile |
| `GET /api/profile/posts?handle=<handle>` | a creator's recent posts, newest first |
| `GET /api/scrape?urls=a,b&handles=c,d` | batch, query form |
| `POST /api/scrape` | batch, JSON body |

Every endpoint accepts `?format=json` (default) or `?format=csv`.

### Examples

```bash
# one video
curl "https://tiktok-scraper.YOUR-SUBDOMAIN.workers.dev/api/video?url=https://www.tiktok.com/@user/video/123"

# one creator: bio, avatar, followers, following, post count
curl "https://tiktok-scraper.YOUR-SUBDOMAIN.workers.dev/api/profile?handle=bellapoarch"

# a creator's 5 most recent posts, with full metadata
curl "https://tiktok-scraper.YOUR-SUBDOMAIN.workers.dev/api/profile/posts?handle=charlidamelio&limit=5"

# batch, as CSV
curl "https://tiktok-scraper.YOUR-SUBDOMAIN.workers.dev/api/scrape?format=csv&urls=URL1,URL2&handles=bellapoarch"

# batch, as JSON
curl -X POST "https://tiktok-scraper.YOUR-SUBDOMAIN.workers.dev/api/scrape" \
     -H "Content-Type: application/json" \
     -d '{"urls":["URL1","URL2"],"handles":["bellapoarch","booktok"]}'
```

### Batch parameters

| Parameter | Default | Meaning |
| --- | --- | --- |
| `delayMs` | 1000 | pause between outgoing requests |
| `concurrency` | 4 | how many requests run in parallel |
| `lang` | `en-US` | `Accept-Language` header |

Maximum **40 items per request** (the free plan allows 50 subrequests and one
TikTok page costs one subrequest).

---

## Protecting the worker

By default the worker is public. To require a key:

```bash
npx wrangler secret put API_KEY
```

Callers then send it in any of these ways:

```bash
-H "X-API-Key: YOUR_KEY"
-H "Authorization: Bearer YOUR_KEY"
"?key=YOUR_KEY"
```

For local testing, copy `.dev.vars.example` to `.dev.vars` and set your own
value — wrangler loads it automatically.

---

## What it collects

**Videos** — video id and URL, creator (handle, nickname, bio, avatar,
followers, following, post count, account likes, verified flag), caption,
hashtags, mentions, sound (title, artist, original flag, duration),
engagement (likes, comments, shares, saves, plays, reposts), publish date and
time, duration, dimensions, thumbnail URL, language, and ad/AI flags.

**Profiles** — handle, nickname, bio, bio link, avatar (three sizes), verified
and private flags, follower / following / post / like counts, account creation
date, and the account's language.

45 columns for videos, 26 for profiles — identical to the Python scraper's
CSV header.

---

## Failure handling

Every response carries a `status` so the caller knows what happened:

| status | meaning | retry? |
| --- | --- | --- |
| `ok` | the request succeeded | - |
| `partial` | some rows only have embed-level data | optional |
| `empty` | the account exists but lists no public posts | no |
| `not_found` | the account does not exist (TikTok errorCode 10221) | no |
| `restricted` | TikTok blocks this account (errorCode 10101 / 209002) | no |
| `rate_limited` | TikTok throttled the request | yes, later |
| `failed` | unexpected failure, see `status_message` | depends |

### TikTok's three ways of saying "slow down"

The important one is easy to miss. TikTok signals throttling with:

- `429 Too Many Requests`
- `5xx` from the edge
- **`400 Bad Request` with the body `ratelimit triggered`**

The third one looks like a broken request, so clients that only retry on 429
and 5xx abort instantly - and accounts that work fine a minute later appear
permanently unavailable. The Worker treats all three as retryable, with a
1-4 s backoff, and also detects the account-level error codes (`10221` =
gone, `10101` = blocked) in the error body.

## Speed

- Video detail pages are fetched **in parallel** (pool of 6, configurable with
  `DETAIL_CONCURRENCY`) instead of one after another. Fetching 20 posts
  sequentially is ~20 round trips; in parallel it is ~4.
- Every fetched page is stored in the **Cloudflare cache** for
  `CACHE_TTL_SECONDS` (default 300 s). A cron that re-pulls the same videos
  every five minutes gets them from the cache in ~150 ms instead of
  re-downloading them.
- The profile page and the embed page are fetched **concurrently**, so their
  latencies overlap instead of adding up.
- A per-request time budget (`PAGE_BUDGET_MS`) stops one slow account from
  eating the whole Worker invocation; videos not reached in time come back
  as `partial` rows with the embed-level data instead of being lost.

Typical numbers measured against live TikTok: 5 posts in ~1.5-2.5 s cold,
~120 ms warm; 20 posts in ~1.3-2.5 s cold, ~200 ms warm.

## Limits, honestly

- **No hashtag discovery.** Workers cannot run a browser, and TikTok renders
  hashtag listings client-side. Use the Python tool to find videos, then feed
  the URLs here. (Creator *profile posts* do work here — see
  `/api/profile/posts`.)
- **Profile posts are capped at 20 per request**, because each one costs a
  subrequest for its detail page. TikTok's embed page typically exposes 3-13
  recent posts per creator.
- **Subrequest cap.** 40 items per request on the free plan. Batch larger
  collections across several requests.
- **CPU limit.** Parsing a full TikTok page costs some CPU. The `wrangler.toml`
  in this repo sets `cpu_ms = 30000`, which needs a paid plan; on the free
  plan (10 ms) large batches may fail with a CPU time error. Keep batches
  small if you are on the free tier.
- **TikTok rate-limits by IP.** Worker egress IPs are shared, so the first
  request or two to a given page often return `429` before the path opens up.
  The Worker retries automatically with a 1-4 s backoff, so a single request
  can take a few seconds. Use `delayMs=1500` or higher for bulk work.
- **Signed URLs expire.** Thumbnail and avatar URLs carry expiry tokens and
  stop working after a few hours. Download them during collection if you need
  the images.

---

## Ethics

Same rules as the Python tool: public data only, no login, no private
accounts, no comment text, no personal data beyond public handles and public
counters. Use a key, keep the sample modest, and publish aggregate analysis
rather than raw data. See the ethics section in the top-level `README.md`.

---

## Layout

```
/
├── wrangler.toml        # Worker config (root - Cloudflare needs it here)
├── package.json         # npm scripts: dev / deploy / typecheck
├── tsconfig.json
├── .dev.vars.example    # copy to .dev.vars for local API-key testing
└── worker/
    ├── src/
    │   ├── index.ts     # router, batch handling, rate limiting, CORS
    │   ├── tiktok.ts    # page parsing + normalisation
    │   └── types.ts     # shared types and column order
    └── README.md
```
