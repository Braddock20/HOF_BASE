# Changelog

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
