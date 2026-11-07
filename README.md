# HOF API — 1.2.2

This release hardens TikTok profile refresh and API edge handling. It does not require a database migration. TikTok scheduled collection remains disabled unless `TIKTOK_SYNC_ENABLED=true` is deliberately enabled.

# Hall of Fame — HOF API Worker

Backend-only Cloudflare Worker API for the Hall of Fame system. This release contains no frontend and no third-party user/admin identity provider. All `/api/admin/*` routes are protected by one server-side master API key supplied in the `X-API-Key` header.

## Included

- Cloudflare Workers + TypeScript + Hono API.
- Neon PostgreSQL schema and initial migration.
- Public profile, search, category, section, rank and health endpoints.
- TikTok scraper adapter with normalized public metadata and nullable metrics.
- Dedicated Discover feed API with session-stable randomized cursor pagination.
- User creator requests, Discover post suggestions, private media uploads and post reports.
- Admin-only review queues for creator requests, post submissions and reports.
- Scheduled metadata polling with post-count change detection and one slow post pull per cron tick.
- Private Backblaze B2 media storage behind stable, non-expiring HOF proxy URLs.
- Profile editing, independent identity/campus verification, moderation, rank creation/assignment and audit views.
- Seeded role/permission definitions and curated sections/categories.
- Request IDs, security headers, JSON response envelopes and rate-limit guard.

## Explicitly not included in this release

- Frontend or browser application.
- Google, Clerk, Auth0, Supabase Auth, OIDC, OAuth, JWT or other third-party authentication.
- Student sign-in / verified submitter identity. Public suggestions and reports are accepted as untrusted submissions and remain private until admin review.
- Instagram/YouTube scraper adapters, verified student identity, direct large-file B2 multipart uploads, and a full frontend.

The master API key currently represents the Super Admin and receives the permissions seeded in `hof_permissions`. Keep it private and use it only from a trusted operator environment. This is intentionally a simple first-stage admin access model; it is not a per-admin key-management system.

## Requirements

- Node.js 20+ (Node 22+ recommended)
- Cloudflare account with Workers deployment access
- Neon PostgreSQL database
- Existing TikTok scraper Worker, if TikTok discovery is enabled

## Local setup

```bash
npm install
cp .dev.vars.example .dev.vars
```

Edit `.dev.vars` with your Neon connection string and a strong random API key. Do not commit `.dev.vars` or paste secrets into chat. Generate a key, for example:

```bash
openssl rand -hex 32
```

Set the result as `ADMIN_API_KEY`. It must be at least 32 characters. The Worker reads it only from its server-side environment and compares the supplied key using a fixed-length SHA-256 comparison. Send it in the `X-API-Key` header; never put it in a URL or frontend bundle.

## Database migration

Back up the target database first. Then:

```bash
export DATABASE_URL='postgresql://...'
npm run db:migrate
```

The migrations create HOF tables, indexes, base sections, categories, permissions and role bundles, then add the independent TikTok creator registry and awards APIs. Admin routes do not require an OIDC subject or an `hof_admins` row in this release. Audit rows identify the actor as `admin-api-key` and leave `actor_admin_id` null.

Test migrations against a staging database before production. The migration script uses the Neon serverless driver for HTTP SQL execution.

## Local checks and run

```bash
npm run typecheck
npm test
npm run dev
```

Health endpoints:
- `GET /api/health`
- `GET /api/health/db`
- `GET /api/health/tiktok`

## Admin API example

```bash
curl 'http://localhost:8787/api/admin/me' \
  -H 'X-API-Key: YOUR_ADMIN_API_KEY'
```

All admin routes require the header. Missing/invalid keys receive `401`; a missing server-side key configuration receives `503`. The API key is not accepted as a query parameter or bearer token.

## Discover and media architecture

- `GET /api/discover/feed` returns 24 items by default and uses `next_cursor` to continue the same feed session. The server stores a randomized post-ID snapshot so page ordering does not shift while a person scrolls. Feed sessions expire after two days.
- `GET /api/discover/latest`, `/posts/:id`, `/categories`, and `/trending` are separate Discover read APIs.
- `POST /api/discover/reports` submits a post report. `POST /api/discover/submissions` submits a TikTok/external post link. `POST /api/discover/creator-requests` suggests a creator. `POST /api/discover/seen` records visible post IDs against a hashed, pseudonymous visitor key; the frontend should also keep seen IDs locally for offline rotation. Send `X-HOF-Visitor` with feed requests to exclude previously seen posts when a new feed session is created. Users cannot assign HOF categories or verification.
- `POST /api/discover/uploads` accepts first-party images and short videos up to 8 MB and stores them in the private B2 bucket. Per the current product rule, successful first-party uploads publish immediately; admins handle reports and post-publication hide/delete/restore actions. TikTok/external submissions remain queued for admin review.
- Admin review routes are under `/api/admin/discover/*`. Creator approval requires an admin-selected `categoryId`.
- `DELETE /api/admin/discover/posts/:id` permanently removes a post and attempts to delete its B2 media objects. `POST /api/admin/profiles/:id/remove` is a soft removal; `DELETE /api/admin/profiles/:id` is the confirmed permanent-delete route.
- Discover JSON never exposes B2 temporary download URLs or raw TikTok cover URLs. B2 media is delivered through stable URLs such as `/api/media/{mediaId}`. The Worker privately authenticates to B2 and streams the object; B2 credentials and authorization tokens never reach the browser. TikTok video posts remain hosted/rendered by TikTok and HOF stores their post ID and canonical post URL. When B2 is configured, TikTok cover images are cached in B2 and delivered through stable HOF URLs. If a cover cannot be cached, the feed returns `thumbnail_url: null` rather than an expiring provider URL.
- The API returns each post's original `width`, `height` and `aspect_ratio`, plus `layout: "masonry"`. The frontend uses these dimensions to create Pinterest-style variable-height columns/tiles; the API does not prescribe screen positions.

## Background TikTok collection

The Worker cron runs every 5 minutes, but scheduled TikTok synchronization is enabled in every Wrangler environment (`TIKTOK_SYNC_ENABLED=true`; set it to `false` to stop collection). It it checks a bounded slice of active, public TikTok creator accounts through the profile endpoint (or the optional batch profile endpoint), compares stored video counts, and periodically reconciles accounts. It processes at most one slow posts endpoint request per invocation. It never downloads TikTok videos, fetches odds, or runs collection in a public API request.

The configured scraper routes are `TIKTOK_PROFILE_PATH=/api/profile` and `TIKTOK_POSTS_PATH=/api/profile/posts`; the posts endpoint is called with `?handle=username`. `TIKTOK_BATCH_PROFILE_PATH` is optional and must accept `POST {"handles":["..."]}` and return a list in `data`, `profiles`, or `users`. Imported posts are checked against the registered creator handle and, when available, platform user ID. Existing HOF moderation states and established creator attribution are preserved during refresh. Engagement snapshots are recorded only when at least one metric is available. Abandoned jobs are recovered after a bounded lease and retried up to three attempts.

## Cloudflare secrets and deployment

```bash
npx wrangler secret put DATABASE_URL
npx wrangler secret put ADMIN_API_KEY
npx wrangler secret put TIKTOK_SCRAPER_API_KEY
npx wrangler secret put B2_ACCOUNT_ID
npx wrangler secret put B2_APPLICATION_KEY_ID
npx wrangler secret put B2_APPLICATION_KEY
npx wrangler secret put B2_BUCKET_ID
npx wrangler secret put B2_BUCKET_NAME
```

Only configure the scraper key if the scraper requires it. Configure non-secret variables in `wrangler.toml` or the Cloudflare dashboard.

```bash
npm run deploy:staging
npm run deploy:production
```

Do not deploy production until database migrations, API-key access, provider health, backups, rate limiting and rollback have been verified. Rotate the admin key immediately if it is exposed.

## Implemented routes

Public read:
- `GET /api/health`, `/api/health/db`, `/api/health/tiktok`, `/api/version`
- `GET /api/profiles`, `/api/profiles/:slug`, `/api/search`
- `GET /api/categories`, `/api/categories/:slug`
- `GET /api/sections`, `/api/sections/:slug`, `/api/featured`, `/api/trending`
- `GET /api/rankings`, `/api/rankings/:slug`, `/api/platforms`

Public submissions:
- `POST /api/discover/submissions`, `/uploads`, `/reports`, `/seen`, `/creator-requests`

Admin (all require `X-API-Key`):
- `GET /api/admin/me`, `/api/admin/profiles`, `/api/admin/ranks`, `/api/admin/audit-logs`
- `GET /api/admin/discover/posts`, `/reports`, `/submissions`, `/creator-requests`, `/media/:id`
- `GET /api/admin/categories`
- `POST /api/admin/categories`, `/profiles/:id/categories`
- `PATCH /api/admin/categories/:id`
- `PATCH /api/admin/discover/reports/:id`, `/submissions/:id`, `/creator-requests/:id`
- `POST /api/admin/discover/posts/:id/review`
- `DELETE /api/admin/discover/posts/:id`, `/api/admin/profiles/:id`
- `POST /api/admin/profiles`
- `PATCH /api/admin/profiles/:id`
- `POST /api/admin/profiles/:id/verify/:type`
- `POST /api/admin/profiles/:id/block|unblock|remove|restore`
- `POST /api/admin/ranks`
- `PATCH /api/admin/ranks/:id`
- `POST /api/admin/profiles/:id/ranks`

## Known implementation gaps

This is a backend foundation, not a production certification. Run migrations 0001, 0002 and 0003 before deploying this version. Verify the mother scraper route paths and batch response shape before enabling scheduled collection. Public submissions currently have no verified student login; treat submitter references as untrusted hints, enforce edge rate limiting/Turnstile before launch, and keep all submissions pending until admin review. The 8 MB B2 upload endpoint is a starter path; larger videos need direct B2 multipart upload authorization. B2 stable URLs depend on the HOF Worker domain remaining active and B2 credentials retaining read access; the underlying B2 download authorization is refreshed server-side and is never sent to clients. Dedicated route slices still remain for verification revocation, rank revocation, section management, profile claims, per-admin account/key rotation, and durable distributed rate limiting. Public voting and nomination submission remain disabled until verified end-user identity and abuse controls exist. Independent TikTok creator profile refresh is implemented, but independent-creator post ingestion is not yet connected to the scheduled queue. Trending remains empty until reliable metric snapshots and a documented algorithm exist. Instagram/YouTube adapters are not faked. Review platform terms before storing or rehosting profile media.

The current rate limiter is per-isolate only. Add Cloudflare WAF/rate limiting or a shared durable limiter before public launch. Keep the master API key in a secret manager and restrict who can read or deploy Worker secrets.

## Independent TikTok Creator Manager (v1.2.0)

This registry is deliberately separate from `hof_profiles` and `hof_social_accounts`. An admin can register a TikTok handle without creating a HOF member/login/profile:

- `GET /api/admin/tiktok-creators?limit=30&offset=0&status=active`
- `POST /api/admin/tiktok-creators` body: `{"username":"creator_handle","displayName":"Optional display name","notes":"Optional admin note"}`
- `GET /api/admin/tiktok-creators/:id`
- `POST /api/admin/tiktok-creators/:id/refresh` (fetches profile metadata and records a metric snapshot)
- `PATCH /api/admin/tiktok-creators/:id` (displayName, notes, status: active/paused/blocked)
- `DELETE /api/admin/tiktok-creators/:id` (soft deactivation; it does not erase history)

All routes require `X-API-Key`. Permissions are `creator.manage` and `creator.sync`. The independent registry currently supports account registration and profile metadata refresh. Once a creator syncs successfully it is linked to a public HOF profile and queued for an immediate first video pull; later pulls happen when the video count grows, when a creator has no stored videos, or on the 24h reconciliation.

## Awards APIs

Public:
- `GET /api/awards`
- `GET /api/awards/:slug` (includes approved nominees and published winners)

Admin:
- `GET /api/admin/awards`
- `POST /api/admin/awards`
- `PATCH /api/admin/awards/:id/status`
- `GET /api/admin/awards/:id/nominations`
- `PATCH /api/admin/awards/nominations/:id`
- `POST /api/admin/awards/:id/winners`

Award creation and winner publication require an audit reason. Public voting is intentionally not exposed: the current project has no verified end-user authentication or abuse-resistant voter identity. The existing `hof_votes` table must not be exposed through a public endpoint until that identity layer exists.

## Configuration and migration 0003

The ZIP includes `wrangler.toml`, `.env.example`, and `.dev.vars.example`. The scraper base URL and endpoint paths are ordinary configuration; Neon, admin key, scraper API key (if used), and B2 credentials remain Cloudflare secrets. Never place real secrets in Wrangler `[vars]`, `.env.example`, or source control.

Run `npm run db:migrate` after backing up the database. The migration runner now applies `0001_initial`, `0002_discover`, and `0003_creator_manager_awards` in order. `TIKTOK_SYNC_ENABLED` remains `false` in all Wrangler environments.


## Leaderboard (v1.2.11)

Public, read-only ranking of accounts with `#1, #2, #3…` labels, computed in SQL from the stored metric snapshots.

- `GET /api/leaderboard/metrics` lists the options.
- `GET /api/leaderboard?metric=followers&limit=20&offset=0`

Metrics: `followers`, `likes`, `videos` (current value, highest first) and, for each, `_gain` (biggest increase), `_loss` (biggest drop, largest loss first) and `_growth` (percentage increase; accounts with a baseline below `minBase`, default 100, are excluded).
Other params: `window=24h|7d|30d` (default 7d, growth metrics only), `platform=tiktok|instagram|youtube` (default tiktok), `strict=true` (exclude accounts whose history is shorter than the window), `limit` (1-100), `offset`.

Each row has `rank`, `rankLabel` (`"#1"`), `username`, `displayName`, `profileSlug`, `value`, `current`, and for growth metrics `previous`, `change`, `growthPct`, `partialWindow`, `baselineAt`. Ties share a rank. History starts when snapshots start being collected, so growth lists fill in over the first day(s); accounts with no usable history are left out rather than shown as 0.
