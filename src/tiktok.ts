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
  const n = Number(v);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}
function first(o: Record<string, unknown>, keys: string[]) {
  for (const k of keys) if (o[k] !== undefined && o[k] !== null) return o[k];
  return null;
}

export function normalizeTikTok(raw: Record<string, unknown>, requested: string): DiscoveredSocialAccount {
  const d = (raw.data && typeof raw.data === "object" ? raw.data : raw) as Record<string, unknown>;
  const username = String(first(d, ["handle", "username", "unique_id"]) || requested).replace(/^@/, "");
  const metrics = {
    followers: num(first(d, ["follower_count", "followers"])),
    following: num(first(d, ["following_count", "following"])),
    videos: num(first(d, ["video_count", "videos"])),
    likes: num(first(d, ["total_likes", "likes"]))
  };
  const availability = Object.fromEntries(Object.entries(metrics).map(([k, v]) => [k, v === null ? "unavailable" : "available"])) as Record<string, "available" | "unavailable">;
  const status = String(d.status || raw.status || "ok").toLowerCase();
  return {
    platform: "tiktok", username,
    platformUserId: first(d, ["user_id", "uid"]) == null ? null : String(first(d, ["user_id", "uid"])),
    platformSecondaryId: first(d, ["sec_uid"]) == null ? null : String(d.sec_uid),
    profileUrl: String(first(d, ["profile_url", "url"]) || `https://www.tiktok.com/@${encodeURIComponent(username)}`),
    displayName: first(d, ["nickname", "display_name"]) == null ? null : String(first(d, ["nickname", "display_name"])),
    bio: first(d, ["bio", "signature"]) == null ? null : String(first(d, ["bio", "signature"])),
    avatarUrl: first(d, ["avatar_large", "avatar_medium", "avatar_thumb"]) == null ? null : String(first(d, ["avatar_large", "avatar_medium", "avatar_thumb"])),
    isPrivate: boolish(d.is_private), platformVerified: boolish(d.verified),
    metrics, metricsAvailability: availability,
    scrapedAt: String(d.scraped_at || new Date().toISOString()),
    providerStatus: status.includes("not_found") ? "not_found" : status.includes("rate") ? "rate_limited" :
      status === "ok" && Object.values(metrics).some(v => v !== null) ? "ok" : "partial",
    providerMessage: raw.message == null ? null : String(raw.message)
  };
}

export async function discoverTikTok(env: Env, username: string): Promise<DiscoveredSocialAccount> {
  if (!env.TIKTOK_SCRAPER_BASE_URL) throw new Error("TikTok scraper is not configured");
  const base = env.TIKTOK_SCRAPER_BASE_URL.replace(/\/+$/, "");
  const url = new URL(`${base}/api/profile`);
  url.searchParams.set("handle", username.replace(/^@/, ""));
  const headers = new Headers({ Accept: "application/json" });
  if (env.TIKTOK_SCRAPER_API_KEY) headers.set("Authorization", `Bearer ${env.TIKTOK_SCRAPER_API_KEY}`);
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
  if (response.status === 404) throw new Error("TikTok account was not found");
  if (response.status === 429) throw new Error("TikTok provider is rate limited");
  if (!response.ok) throw new Error(`TikTok provider returned ${response.status}`);
  const raw = await response.json() as Record<string, unknown>;
  return normalizeTikTok(raw, username);
}
