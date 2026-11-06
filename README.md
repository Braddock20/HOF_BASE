# Hall of Fame — HOF API Worker

Backend-only Cloudflare Worker API for the Hall of Fame system. This release contains no frontend and no third-party user/admin identity provider. All `/api/admin/*` routes are protected by one server-side master API key supplied in the `X-API-Key` header.

## Included

- Cloudflare Workers + TypeScript + Hono API.
- Neon PostgreSQL schema and initial migration.
- Public profile, search, category, section, rank and health endpoints.
- TikTok scraper adapter with normalized public metadata and nullable metrics.
- API-key protected admin endpoints and database-seeded permission checks.
- Profile editing, independent identity/campus verification, moderation, rank creation/assignment and audit views.
- Seeded role/permission definitions and curated sections/categories.
- Request IDs, security headers, JSON response envelopes and rate-limit guard.

## Explicitly not included in this release

- Frontend or browser application.
- Google, Clerk, Auth0, Supabase Auth, OIDC, OAuth, JWT or other third-party authentication.
- Student sign-in. Student nominations and public reports return `501 NOT_CONFIGURED` until a first-party identity and abuse-control design is added.
- Instagram/YouTube scraping, automatic metric scheduling, award voting, claims, or a complete admin management API.

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

The migration creates HOF tables, indexes, base sections, categories, permissions and role bundles. Admin routes do not require an OIDC subject or an `hof_admins` row in this release. Audit rows identify the actor as `admin-api-key` and leave `actor_admin_id` null.

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

## Cloudflare secrets and deployment

```bash
npx wrangler secret put DATABASE_URL
npx wrangler secret put ADMIN_API_KEY
npx wrangler secret put TIKTOK_SCRAPER_API_KEY
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

Deferred public write:
- `POST /api/nominations` — `501 NOT_CONFIGURED`
- `POST /api/reports` — `501 NOT_CONFIGURED`

Admin (all require `X-API-Key`):
- `GET /api/admin/me`, `/api/admin/profiles`, `/api/admin/ranks`, `/api/admin/audit-logs`
- `POST /api/admin/profiles`
- `PATCH /api/admin/profiles/:id`
- `POST /api/admin/profiles/:id/verify/:type`
- `POST /api/admin/profiles/:id/block|unblock|remove|restore`
- `POST /api/admin/ranks`
- `PATCH /api/admin/ranks/:id`
- `POST /api/admin/profiles/:id/ranks`

## Known implementation gaps

This is a backend foundation, not a production certification. Dedicated route slices still remain for verification revocation, rank revocation, section/category management, complete admin/key rotation management, award lifecycle and voting, claims, metric synchronization/snapshots, and durable distributed rate limiting. Trending remains empty until reliable metric snapshots and a documented algorithm exist. Instagram/YouTube adapters are not faked. Review platform terms before storing or rehosting profile media.

The current rate limiter is per-isolate only. Add Cloudflare WAF/rate limiting or a shared durable limiter before public launch. Keep the master API key in a secret manager and restrict who can read or deploy Worker secrets.
