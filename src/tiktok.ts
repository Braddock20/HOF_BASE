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
  const status = String(statusValue ?? "ok").toLowerCase();
  if (status.includes("not_found") || status === "not found" || status === "404") return "not_found";
  if (status.includes("rate") || status === "429") return "rate_limited";
  if (status === "error" || status === "failed" || status === "false") return "error";
  if (status === "ok" && Object.values(metrics).some(value => value !== null)) return "ok";
  return "partial";
}

export function normalizeTikTok(raw: Record<string, unknown>, requested: string): DiscoveredSocialAccount {
  const nested = raw.data && typeof raw.data === "object" && !Array.isArray(raw.data)
    ? raw.data as Record<string, unknown>
    : raw;
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
  const status = providerStatus(first(nested, ["status"]) ?? (first(raw, ["status"]) ?? "ok"), metrics);

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
    providerMessage: cleanText(first(raw, ["message", "error"]), 500)
  };
}

export async function discoverTikTok(env: Env, username: string): Promise<DiscoveredSocialAccount> {
  if (!env.TIKTOK_SCRAPER_BASE_URL) throw new Error("TikTok scraper is not configured");
  const base = new URL(env.TIKTOK_SCRAPER_BASE_URL);
  if (base.protocol !== "https:") throw new Error("TikTok scraper URL must use HTTPS");
  const url = new URL(env.TIKTOK_PROFILE_PATH || "/api/profile", `${base.toString().replace(/\/+$/, "")}/`);
  url.searchParams.set("handle", username.replace(/^@/, ""));
  const headers = new Headers({ Accept: "application/json" });
  if (env.TIKTOK_SCRAPER_API_KEY) headers.set("Authorization", `Bearer ${env.TIKTOK_SCRAPER_API_KEY}`);
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(15_000), redirect: "error" });
  if (response.status === 404) throw new Error("TikTok account was not found");
  if (response.status === 429) throw new Error("TikTok provider is rate limited");
  if (!response.ok) throw new Error(`TikTok provider returned ${response.status}`);
  const raw = await response.json() as Record<string, unknown>;
  const result = normalizeTikTok(raw, username);
  if (result.providerStatus === "not_found") throw new Error("TikTok account was not found");
  if (result.providerStatus === "rate_limited") throw new Error("TikTok provider is rate limited");
  if (result.providerStatus === "error") throw new Error("TikTok provider returned an unsuccessful profile response");
  return result;
}
