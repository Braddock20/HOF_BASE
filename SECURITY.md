# Security notes

- Admin routes require the `X-API-Key` header and a server-side `ADMIN_API_KEY` secret of at least 32 characters.
- Never put the admin key in a URL, browser/frontend code, source control, logs or public documentation.
- Rotate the key immediately if exposed. Restrict Cloudflare secret access and deployment permissions.
- The current key is a single Super Admin credential; it is not individually attributable or independently revocable per administrator.
- Public profile reads filter blocked/removed and hidden profiles.
- Metrics are nullable; unavailable values are not rewritten as zero.
- Provider URLs and scraper credentials remain server-side.
- The current in-memory rate limiter is per-isolate, not a distributed abuse-control system. Add Cloudflare WAF/rate limiting or a shared limiter before launch.
- Use a restricted runtime database role in production. The migration role should not be the long-lived application role.
- Audit logs record the API-key actor as `admin-api-key`; the current master-key model does not identify the individual operator.
