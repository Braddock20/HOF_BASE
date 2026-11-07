# Changelog

## 1.2.15 — Say why videos are skipped
- `pullPosts` counts why each video was skipped (no_id, bad_url, status_<x>, ad, other_author, deleted, owned_by_other_creator, conflict).
- If videos are received but none are stored, the job now fails with those reasons in `error_summary` instead of being recorded as succeeded (which also re-queued the account on every cron run).

## 1.2.14 — Failing accounts no longer block the queue
- Fresh jobs are claimed before retried ones (`attempts ASC`), so a creator whose videos cannot be read goes to the back after each failure.
- A failed pull no longer ends the collection run; it stops early only on rate-limit style errors.

## 1.2.13 — Leaderboard `_change` metrics
- Added `followers_change`, `likes_change`, `videos_change`: all accounts with history, signed change over the window, for a gains-and-losses ticker view.

## 1.2.11 — Always-on collector and initial video pulls
- `TIKTOK_SYNC_ENABLED` is now `"true"` in every Wrangler environment (the flag remains as a kill switch).
- Newly added/linked creators are pulled first: queued jobs from `creator-linked` / `missing-videos` are claimed before routine refreshes, and adding a creator starts one pull immediately.
- New backfill rule: if the profile reports videos but none are stored for the creator, a `missing-videos` job is queued regardless of the 24h reconciliation timer.
- An empty posts response now fails the job (and retries) when the scraper sent a warning or the profile reports videos, instead of being recorded as succeeded.
- After 3 failed attempts an account is not re-queued for 6 hours.
- Added `GET /api/leaderboard` (+ `/metrics`): rankings by followers, likes, videos, gains, losses and growth % with `#n` labels, plus an admin console tab. No migration required.
- Extracted `processQueuedJobs` from the scheduled collector. No database migration required.

## 1.2.2 — TikTok integration and resilience hardening
- Removed unintended Bearer-token forwarding to the confirmed public TikTok scraper endpoints, preventing stale HOF secrets from causing upstream authorization/routing failures.
- Distinguished a missing scraper route (HTTP 404) from a scraper-reported missing TikTok account.
- Added URL/path validation, JSON/content-type validation, explicit profile-handle validation, safe transient retry, and clearer provider errors.
- Added coverage for the exact live scraper response shape, including string-valued `False` flags.
- Allowed `X-API-Key` in configured frontend CORS preflights.
- Bounded the per-isolate rate-limit map and corrected TikTok health reporting so it no longer probes a nonexistent `/api/health` endpoint.
- Kept scheduled TikTok sync disabled by default. No database migration is required.

# Changelog

## 1.1.3 — TikTok creator sync hardening

- Hardened profile normalization, status handling, HTTPS URL validation and identity consistency checks.
- Verified every imported TikTok post against the registered creator handle and, when available, platform user ID.
- Preserved existing Discover moderation states during post refresh; deleted-source tombstones remain authoritative.
- Refreshed safe post metadata and engagement values without overwriting established HOF creator attribution.
- Added metric snapshots only when at least one engagement metric is available.
- Added abandoned-job recovery, bounded retries, one-post-pull-per-invocation behavior and explicit sync opt-in checks.
- Restricted cover caching to supported TikTok CDN hostnames and image MIME types; B2 cache failures do not block post imports.
- Corrected B2 authorization parsing to support the nested v3 `apiInfo.storageApi` response while retaining legacy response compatibility.
- Kept `TIKTOK_SYNC_ENABLED=false` in all Wrangler environments.

## 1.0.1
- Removed third-party/OIDC/JWT authentication from the Worker.
- Protected all admin API routes with a server-side `ADMIN_API_KEY` supplied through `X-API-Key`.
- Kept permission checks backed by the seeded database permission catalogue; the configured key acts as the Super Admin.
- Removed frontend-origin/CORS configuration because this release has no frontend.
- Deferred student nominations and public reports until a first-party identity and abuse-control design exists.

## 1.0.0
- Added the initial Cloudflare Worker API, Neon schema, TikTok adapter, RBAC permission catalogue and initial admin operations.


## 1.1.0 — Discover + private media delivery

- Added Discover feed, latest, post detail, categories, trending, reports, submissions, creator requests, seen-history and first-party upload APIs.
- Added cursor-paginated randomized feed sessions, seen-post exclusion, and masonry dimension metadata.
- Added admin-only queues and review actions for reports, Discover submissions and creator requests; creator approval requires an admin-selected category.
- Added admin Discover moderation and confirmed permanent post/profile deletion.
- Added private Backblaze B2 object storage with stable HOF media proxy URLs; temporary B2 authorization tokens and raw expiring TikTok cover URLs are not exposed to clients.
- Added scheduled TikTok metadata polling, post-count change detection, one-at-a-time slow post pulls, retries, periodic reconciliation and metric snapshots.
- Added tombstones so permanently deleted TikTok posts are not re-imported.
- Added restricted configurable CORS and new Discover/media permissions.
- Added migration `0002_discover.sql`.

## 1.2.0 — independent creator registry and awards APIs

- Added an independent TikTok creator registry that does not require a HOF profile or HOF login.
- Added admin list/add/view/edit/deactivate and on-demand profile metadata refresh endpoints.
- Added metric history storage for independent TikTok creator profile snapshots.
- Added public award listing/detail endpoints and admin award lifecycle, nomination review and winner publishing endpoints.
- Added migration `0003_creator_manager_awards.sql` and registered it in the migration runner.
- Added `.env.example` and documented Wrangler scraper configuration. TikTok scheduled sync remains disabled by default.
