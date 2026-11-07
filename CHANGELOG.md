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
