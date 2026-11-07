import type { Env } from "./types";
import { boolish } from "./http";

export interface DiscoveredSocialAccount {
  platform: "tiktok";
  username: string;
  platformUserId: string | null;
  platformSecondaryId: string | null;
  profileUrl: string;
  displayName: string | null;
  bio: string | null;
  avatarUrl: string | null;
  isPrivate: boolean | null;
  platformVerified: boolean | null;
  metrics: { followers: number | null; following: number | null; videos: number | null; likes: number | null };
  metricsAvailability: Record<string, "available" | "unavailable">;
  scrapedAt: string;
  providerStatus: "ok" | "partial" | "not_found" | "rate_limited" | "error";
  providerMessage: string | null;
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const value = Number(v);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function first(o: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) if (o[key] !== undefined && o[key] !== null) return o[key];
  return null;
}

function cleanText(value: unknown, max = 4000): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const result = String(value).trim();
  return result ? result.slice(0, max) : null;
}

function httpsUrl(value: unknown, fallback: string | null = null): string | null {
  const candidate = cleanText(value, 2048);
  if (!candidate) return fallback;
  try {
    const url = new URL(candidate);
    return url.protocol === "https:" ? url.toString() : fallback;
  } catch {
    return fallback;
  }
}

function tiktokProfileUrl(value: unknown, fallback: string): string {
  const candidate = httpsUrl(value);
  if (!candidate) return fallback;
  try {
    const url = new URL(candidate);
    const host = url.hostname.toLowerCase();
    return ["tiktok.com", "www.tiktok.com", "m.tiktok.com"].includes(host) ? url.toString() : fallback;
  } catch {
    return fallback;
  }
}

function providerStatus(statusValue: unknown, metrics: Record<string, number | null>): DiscoveredSocialAccount["providerStatus"] {
  const status = String(statusValue ?? "ok").trim().toLowerCase();
  if (["not_found", "not found", "404"].includes(status)) return "not_found";
  if (["rate_limited", "rate limited", "429"].includes(status) || status.includes("rate limit")) return "rate_limited";
  if (["error", "failed", "failure"].includes(status)) return "error";
  if (status === "ok" && Object.values(metrics).some(value => value !== null)) return "ok";
  return "partial";
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.toLowerCase().includes("json")) {
    throw new Error(`TikTok scraper returned non-JSON content (HTTP ${response.status})`);
  }
  let payload: unknown;
  try { payload = await response.json(); }
  catch { throw new Error("TikTok scraper returned invalid JSON"); }
  const parsed = record(payload);
  if (!parsed) throw new Error("TikTok scraper returned an unexpected response format");
  return parsed;
}

export function normalizeTikTok(raw: Record<string, unknown>, requested: string): DiscoveredSocialAccount {
  const data = record(raw.data);
  const nested = record(data?.profile) || record(raw.profile) || data || raw;
  const username = (cleanText(first(nested, ["handle", "username", "unique_id"]), 100) || requested.replace(/^@/, "").trim()).replace(/^@/, "");
  const metrics = {
    followers: num(first(nested, ["follower_count", "followers"])),
    following: num(first(nested, ["following_count", "following"])),
    videos: num(first(nested, ["video_count", "videos"])),
    likes: num(first(nested, ["total_likes", "likes"]))
  };
  const metricsAvailability = Object.fromEntries(
    Object.entries(metrics).map(([key, value]) => [key, value === null ? "unavailable" : "available"])
  ) as Record<string, "available" | "unavailable">;
  const profileFallback = `https://www.tiktok.com/@${encodeURIComponent(username)}`;
  const status = providerStatus(first(nested, ["status", "provider_status"]) ?? first(raw, ["status", "provider_status"]) ?? "ok", metrics);

  return {
    platform: "tiktok",
    username,
    platformUserId: cleanText(first(nested, ["user_id", "uid"]), 200),
    platformSecondaryId: cleanText(first(nested, ["sec_uid"]), 500),
    profileUrl: tiktokProfileUrl(first(nested, ["profile_url", "url"]), profileFallback),
    displayName: cleanText(first(nested, ["nickname", "display_name"]), 300),
    bio: cleanText(first(nested, ["bio", "signature"]), 4000),
    avatarUrl: httpsUrl(first(nested, ["avatar_large", "avatar_medium", "avatar_thumb"])),
    isPrivate: boolish(nested.is_private),
    platformVerified: boolish(nested.verified),
    metrics,
    metricsAvailability,
    scrapedAt: cleanText(nested.scraped_at, 100) || new Date().toISOString(),
    providerStatus: status,
    providerMessage: cleanText(first(nested, ["status_message", "message", "error"]) ?? first(raw, ["status_message", "message", "error"]), 500)
  };
}

export async function discoverTikTok(env: Env, username: string): Promise<DiscoveredSocialAccount> {
  if (!env.TIKTOK_SCRAPER_BASE_URL) throw new Error("TikTok scraper is not configured");
  let base: URL;
  try { base = new URL(env.TIKTOK_SCRAPER_BASE_URL); }
  catch { throw new Error("TIKTOK_SCRAPER_BASE_URL is not a valid URL"); }
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash) {
    throw new Error("TikTok scraper URL must be a clean HTTPS URL without credentials, query, or fragment");
  }
  const path = env.TIKTOK_PROFILE_PATH || "/api/profile";
  let url: URL;
  try { url = new URL(path, `${base.toString().replace(/\/+$/, "")}/`); }
  catch { throw new Error("TIKTOK_PROFILE_PATH is invalid"); }
  if (url.origin !== base.origin) throw new Error("TIKTOK_PROFILE_PATH must stay on the configured scraper host");
  url.searchParams.set("handle", username.replace(/^@/, "").trim());

  // The configured scraper endpoint is public. Do not send a stale or unrelated
  // Bearer token: some edge routers intentionally answer 404 for failed auth.
  const headers = new Headers({ Accept: "application/json" });
  let response: Response | null = null;
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      response = await fetch(url, { headers, signal: AbortSignal.timeout(15_000), redirect: "manual" });
      if (!retryableStatus(response.status) || attempt === 1) break;
      await response.body?.cancel();
    } catch (error) {
      lastError = error;
      if (attempt === 1) {
        const name = error instanceof Error ? error.name : "";
        throw new Error(name === "TimeoutError" || name === "AbortError"
          ? "TikTok scraper request timed out after retry"
          : "Could not connect to the TikTok scraper after retry");
      }
    }
    await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
  }
  if (!response) throw new Error(lastError instanceof Error ? lastError.message : "TikTok scraper did not return a response");
  if (response.status === 429) throw new Error("TikTok provider is rate limited; retry later");
  if (response.status === 404) {
    let body: Record<string, unknown> | null = null;
    try { body = await readJson(response); } catch { /* route-level 404 may be plain text */ }
    const data = record(body?.data) || body;
    const providerState = String(first(data || {}, ["status", "provider_status", "error_code"]) ?? "").toLowerCase();
    if (["not_found", "not found", "account_not_found", "user_not_found"].includes(providerState)) {
      throw new Error("TikTok account was not found by the scraper");
    }
    throw new Error(`TikTok scraper endpoint returned 404; check TIKTOK_PROFILE_PATH (${path})`);
  }
  if (!response.ok) {
    if (response.status >= 500) throw new Error(`TikTok scraper is temporarily unavailable (HTTP ${response.status})`);
    throw new Error(`TikTok scraper rejected the request (HTTP ${response.status})`);
  }

  const raw = await readJson(response);
  const result = normalizeTikTok(raw, username);
  if (result.providerStatus === "not_found") throw new Error("TikTok account was not found by the scraper");
  if (result.providerStatus === "rate_limited") throw new Error("TikTok provider is rate limited; retry later");
  if (result.providerStatus === "error") throw new Error(result.providerMessage || "TikTok provider returned an unsuccessful profile response");
  const profileData = record(record(raw.data)?.profile) || record(raw.profile) || record(raw.data) || raw;
  if (!cleanText(first(profileData, ["handle", "username", "unique_id"]), 100)) {
    throw new Error("TikTok scraper response is missing the account handle; no creator data was changed");
  }
  return result;
}
