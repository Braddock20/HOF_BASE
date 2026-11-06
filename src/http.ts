import type { Context } from "hono";
import type { Env, AppVariables } from "./types";

export type AppContext = Context<{ Bindings: Env; Variables: AppVariables }>;

export function ok(c: AppContext, data: unknown, status = 200, extra: Record<string, unknown> = {}) {
  return c.json({ ok: true, data, meta: { requestId: c.get("requestId"), ...extra } }, status as never);
}
export function fail(c: AppContext, status: number, code: string, message: string, details: unknown[] = []) {
  return c.json({ ok: false, error: { code, message, details }, meta: { requestId: c.get("requestId") } }, status as never);
}
export function requiredString(v: unknown, max = 500): v is string {
  return typeof v === "string" && v.trim().length > 0 && v.length <= max;
}
export function slugify(s: string) {
  return s.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);
}
export function boolish(v: unknown): boolean | null {
  if (v === true || v === "true" || v === "True" || v === 1) return true;
  if (v === false || v === "false" || v === "False" || v === 0) return false;
  return null;
}
