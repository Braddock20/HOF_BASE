import type { MiddlewareHandler } from "hono";
import type { Env, AppVariables } from "./types";
import { db } from "./db";
import { fail } from "./http";

type HonoEnv = { Bindings: Env; Variables: AppVariables };

async function matchesApiKey(provided: string, expected: string): Promise<boolean> {
  // Hash first so comparison always operates on fixed-length values.
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected))
  ]);
  const left = new Uint8Array(a);
  const right = new Uint8Array(b);
  let difference = 0;
  for (let i = 0; i < left.length; i++) difference |= left[i] ^ right[i];
  return difference === 0;
}

/** One server-side master API key currently acts as the HOF Super Admin. */
export const requireAdmin: MiddlewareHandler<HonoEnv> = async (c, next) => {
  const expected = c.env.ADMIN_API_KEY;
  const provided = c.req.header("X-API-Key") || "";
  if (!expected || expected.length < 32) {
    return fail(c, 503, "ADMIN_AUTH_NOT_CONFIGURED", "The admin API key is not configured securely.");
  }
  if (!provided || !(await matchesApiKey(provided, expected))) {
    return fail(c, 401, "UNAUTHORIZED", "A valid admin API key is required.");
  }

  try {
    const rows = await db(c.env).query<{ permission_key: string }>(
      "SELECT permission_key FROM hof_permissions ORDER BY permission_key"
    );
    c.set("adminId", undefined);
    c.set("subject", "admin-api-key");
    c.set("permissions", new Set(rows.map(row => row.permission_key)));
    await next();
  } catch {
    return fail(c, 503, "DATABASE_UNAVAILABLE", "Administrator permissions could not be loaded.");
  }
};

export function requirePermission(permission: string): MiddlewareHandler<HonoEnv> {
  return async (c, next) => {
    if (!c.get("permissions")?.has(permission)) return fail(c, 403, "FORBIDDEN", "The API key does not grant this permission.");
    await next();
  };
}
