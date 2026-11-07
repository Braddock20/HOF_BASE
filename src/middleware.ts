import type { MiddlewareHandler } from "hono";
import { fail } from "./http";
import type { Env, AppVariables } from "./types";

type HonoEnv = { Bindings: Env; Variables: AppVariables };

export const requestId: MiddlewareHandler<HonoEnv> = async (c, next) => {
  const supplied = c.req.header("x-request-id");
  c.set("requestId", supplied && /^[a-zA-Z0-9._-]{8,100}$/.test(supplied) ? supplied : crypto.randomUUID());
  await next();
  c.header("x-request-id", c.get("requestId"));
};

export const securityHeaders: MiddlewareHandler<HonoEnv> = async (c, next) => {
  await next();
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "strict-origin-when-cross-origin");
  c.header("X-Frame-Options", "DENY");
  c.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  if (!c.res.headers.has("Cache-Control")) c.header("Cache-Control", "no-store");
};


export const basicRateLimit: MiddlewareHandler<HonoEnv> = async (c, next) => {
  // Per-isolate guard only. Production deployments should additionally enable
  // Cloudflare WAF/rate limiting or a durable shared limiter.
  if (c.env.RATE_LIMIT_ENABLED !== "true") return next();
  const key = `${c.req.method}:${new URL(c.req.url).pathname}:${c.req.header("cf-connecting-ip") || "unknown"}`;
  const store = (globalThis as unknown as { __hofRate?: Map<string, { n: number; t: number }> }).__hofRate ||= new Map();
  const now = Date.now();
  if (store.size > 5000) {
    for (const [entryKey, entry] of store) if (now - entry.t > 60_000) store.delete(entryKey);
    if (store.size > 5000) store.clear();
  }
  const item = store.get(key);
  if (!item || now - item.t > 60_000) store.set(key, { n: 1, t: now });
  else if (++item.n > 120) return fail(c, 429, "RATE_LIMITED", "Too many requests. Try again shortly.");
  await next();
};


export const restrictedCors: MiddlewareHandler<HonoEnv> = async (c, next) => {
  // One rule for every route (public and admin): any page may call the API, hosted, localhost,
  // or file:// (Origin "null"). Safe because auth is the X-API-Key header, never cookies, and
  // Access-Control-Allow-Credentials is never sent, so a third-party page cannot act without the key.
  c.header("Access-Control-Allow-Origin", "*");
  c.header("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
  c.header("Access-Control-Allow-Headers", "Content-Type, X-Request-ID, X-API-Key, X-HOF-Visitor");
  c.header("Access-Control-Expose-Headers", "X-Request-ID, Retry-After");
  c.header("Access-Control-Max-Age", "600");
  if (c.req.method === "OPTIONS") return c.body(null, 204);
  await next();
};
