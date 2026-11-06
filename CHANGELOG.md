# Changelog

## 1.0.1
- Removed third-party/OIDC/JWT authentication from the Worker.
- Protected all admin API routes with a server-side `ADMIN_API_KEY` supplied through `X-API-Key`.
- Kept permission checks backed by the seeded database permission catalogue; the configured key acts as the Super Admin.
- Removed frontend-origin/CORS configuration because this release has no frontend.
- Deferred student nominations and public reports until a first-party identity and abuse-control design exists.

## 1.0.0
- Added the initial Cloudflare Worker API, Neon schema, TikTok adapter, RBAC permission catalogue and initial admin operations.
