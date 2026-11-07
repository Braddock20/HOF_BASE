import { ProfileRecord, VideoRecord } from "./types";

export const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const REHYDRATION_RE =
  /<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application\/json">([\s\S]*?)<\/script>/;

const FRONTITY_RE =
  /<script[^>]*id="__FRONTITY_CONNECT_STATE__"[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/;

const HASHTAG_RE = /#([\wÀ-ɏ]+)/g;
const MENTION_RE = /@([\w.\-]+)/g;

const MULTIPLIERS: Record<string, number> = {
  K: 1_000,
  M: 1_000_000,
  B: 1_000_000_000,
};

/** How a TikTok request failed. Mirrors the statuses `hof-base` understands. */
export type FailureKind = "not_found" | "restricted" | "rate_limited" | "error";

export class TikTokError extends Error {
  readonly kind: FailureKind;
  readonly status: number;
  readonly retryable: boolean;

  constructor(kind: FailureKind, message: string, status = 0, retryable = false) {
    super(message);
    this.name = "TikTokError";
    this.kind = kind;
    this.status = status;
    this.retryable = retryable;
  }
}

/** Coerce a TikTok stat into a number, understanding K/M/B suffixes. */
export function parseNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value ? 1 : 0;

  let text = String(value).trim().replace(/,/g, "");
  if (!text) return null;

  let multiplier = 1;
  const last = text.slice(-1).toUpperCase();
  if (last in MULTIPLIERS) {
    multiplier = MULTIPLIERS[last];
    text = text.slice(0, -1).trim();
  }
  const parsed = Number.parseFloat(text);
  return Number.isFinite(parsed) ? Math.round(parsed * multiplier) : null;
}

// ---------------------------------------------------------------- fetching

export interface FetchOptions {
  language?: string;
  /** ExecutionContext, used to cache the response in the background. */
  ctx?: ExecutionContext;
  /** Cache lifetime in seconds. 0 disables caching. */
  cacheTtl?: number;
  /** Cache key suffix, so different variants do not collide. */
  cacheTag?: string;
  retries?: number;
  signal?: AbortSignal;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Does this body mean "you are being throttled"?
 *
 * TikTok signals throttling three different ways, and only one of them is
 * an HTTP error code:
 *   - 429 Too Many Requests
 *   - 400 with the plain-text body "ratelimit triggered"
 *   - 5xx from the edge
 *
 * The 400 case is the trap: it looks like a bad request, so naive clients
 * abort instantly instead of retrying, and accounts that work fine a
 * minute later appear "unavailable".
 */
function isThrottleBody(text: string): boolean {
  if (!text) return false;
  const head = text.slice(0, 400).toLowerCase();
  if (head.includes("ratelimit triggered")) return true;
  if (head.includes("rate limit") || head.includes("too many requests")) return true;
  return false;
}

/** TikTok's account-level error codes, read out of the error body. */
function errorCodeIn(text: string): string | null {
  const match = /"errorCode"\s*[:=]\s*"?(\d+)"?/.exec(text || "");
  return match ? match[1] : null;
}

/**
 * Classify a failed TikTok response.
 *   10221 -> the account does not exist
 *   10101 -> the account exists but TikTok blocks the embed surface
 *   209002 (profile scope) -> the account is restricted
 */
function classifyFailure(status: number, body: string): TikTokError {
  const code = errorCodeIn(body);
  if (code === "10221") {
    return new TikTokError("not_found", "TikTok account does not exist", status);
  }
  if (code === "10101") {
    return new TikTokError(
      "restricted",
      "TikTok blocks this account (errorCode 10101)",
      status,
    );
  }
  if (status === 404) {
    return new TikTokError("not_found", "TikTok returned 404", status);
  }
  if (status === 429 || isThrottleBody(body)) {
    return new TikTokError(
      "rate_limited",
      "TikTok rate limited the request",
      status,
      true,
    );
  }
  if (status >= 500) {
    return new TikTokError("error", `TikTok server error (HTTP ${status})`, status, true);
  }
  return new TikTokError("error", `TikTok rejected the request (HTTP ${status})`, status);
}

/** Cache key for a TikTok page fetch. */
function cacheKey(url: string, tag: string): Request {
  return new Request(`https://cache.local/${tag}/${encodeURIComponent(url)}`, {
    headers: { "Cache-Tag": tag },
  });
}

/**
 * Fetch a TikTok page.
 *
 * Retries throttles (429, 5xx, and the 400 "ratelimit triggered" case) with
 * a backoff, and caches successful responses in the Cloudflare cache so the
 * every-5-minute cron does not re-download the same pages.
 */
export async function fetchPage(
  url: string,
  options: FetchOptions = {},
): Promise<string> {
  const {
    language = "en-US",
    ctx,
    cacheTtl = 300,
    cacheTag = "tiktok-page",
    retries = 4,
    signal,
  } = options;

  const cache = typeof caches !== "undefined" ? caches.default : null;
  const key = cacheKey(url, cacheTag);

  if (cache && cacheTtl > 0) {
    const hit = await cache.match(key);
    if (hit) return await hit.text();
  }

  let lastError: TikTokError | null = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      // 1s, 2s, 3s, 4s - jittered so parallel workers do not sync up.
      await sleep(attempt * 1000 + Math.floor(Math.random() * 400));
    }

    let response: Response;
    try {
      response = await fetch(url, {
        headers: {
          "User-Agent": DEFAULT_UA,
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": `${language},en;q=0.9`,
          Referer: "https://www.tiktok.com/",
          "Upgrade-Insecure-Requests": "1",
        },
        redirect: "follow",
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      lastError = new TikTokError(
        "error",
        `network error fetching ${url}: ${String(error)}`,
        0,
        true,
      );
      continue;
    }

    if (response.ok) {
      const text = await response.text();
      if (cache && cacheTtl > 0) {
        const copy = new Response(text, {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": `public, max-age=${cacheTtl}`,
          },
        });
        if (ctx) ctx.waitUntil(cache.put(key, copy));
        else await cache.put(key, copy);
      }
      return text;
    }

    const body = await response.text().catch(() => "");
    const failure = classifyFailure(response.status, body);
    lastError = failure;

    // Only throttles and server errors are worth another attempt.
    if (!failure.retryable) throw failure;
  }

  throw lastError ?? new TikTokError("error", `failed to fetch ${url}`);
}

// ---------------------------------------------------------------- parsing

export function parseRehydration(html: string): any | null {
  const match = REHYDRATION_RE.exec(html);
  if (!match) return null;
  try {
    const payload = JSON.parse(match[1]);
    const scope = payload?.__DEFAULT_SCOPE__;
    return scope && typeof scope === "object" ? scope : null;
  } catch {
    return null;
  }
}

export function parseFrontity(html: string): any | null {
  const match = FRONTITY_RE.exec(html);
  if (!match) return null;
  try {
    const payload = JSON.parse(match[1]);
    const data = payload?.source?.data;
    return data && typeof data === "object" ? data : null;
  } catch {
    return null;
  }
}

/** Read the video-detail payload out of a TikTok video page. */
export function extractVideoItem(html: string): { item: any; message: string } {
  const scope = parseRehydration(html);
  if (!scope) return { item: null, message: "no_rehydration_json" };

  const detail = scope["webapp.video-detail"] || {};
  const statusCode = detail.statusCode;
  const statusMsg = detail.statusMsg || "";
  const itemStruct = detail?.itemInfo?.itemStruct;

  if (!itemStruct || typeof itemStruct !== "object") {
    if (statusCode) {
      return { item: null, message: `unavailable (statusCode=${statusCode} ${statusMsg})`.trim() };
    }
    return { item: null, message: "item_struct_missing" };
  }
  if (statusCode !== 0 && statusCode !== undefined && statusCode !== null) {
    return {
      item: null,
      message: `unavailable (statusCode=${statusCode} ${statusMsg})`.trim(),
    };
  }
  return { item: itemStruct, message: "" };
}

/** Read the creator payload out of a TikTok profile page. */
export function extractProfile(
  html: string,
  handle: string,
): { user: any; stats: any; message: string; statusCode: number | null } {
  const scope = parseRehydration(html);
  if (!scope) {
    return { user: null, stats: null, message: "no_rehydration_json", statusCode: null };
  }

  const detail = scope["webapp.user-detail"] || {};
  const statusCode = detail.statusCode ?? null;
  const statusMsg = detail.statusMsg || "";
  const userInfo = detail.userInfo || {};
  const user = userInfo.user;
  const stats = userInfo.stats || {};

  if (!user || typeof user !== "object") {
    if (statusCode === 10221) {
      return { user: null, stats: null, message: "account does not exist", statusCode };
    }
    if (statusCode === 209002) {
      return { user: null, stats: null, message: "account is restricted by TikTok", statusCode };
    }
    if (statusCode) {
      return {
        user: null,
        stats: null,
        message: `unavailable (statusCode=${statusCode} ${statusMsg})`.trim(),
        statusCode,
      };
    }
    return { user: null, stats: null, message: "profile_data_missing", statusCode };
  }
  return { user, stats, message: "", statusCode };
}

/**
 * Read `{ userInfo, videos }` out of an embed page.
 *
 * The embed page is the only surface that lists a creator's recent posts
 * without a signed API request. Its list is ordered newest-first.
 */
export function embedProfile(
  html: string,
  handle: string,
): { userInfo: any; videos: any[] } {
  const data = parseFrontity(html);
  if (!data) return { userInfo: {}, videos: [] };

  const wanted = handle.replace(/^@/, "").toLowerCase();
  // The payload key mirrors the handle exactly as the page was requested,
  // but case can differ (TikTok handles are lowercase while callers often
  // are not). Match case-insensitively rather than losing the whole page.
  const key =
    Object.keys(data).find((candidate) => candidate.toLowerCase() === `/embed/@${wanted}`) ??
    Object.keys(data).find((candidate) => candidate.toLowerCase().includes(`@${wanted}`));

  const profile = key ? data[key] : undefined;
  if (!profile || typeof profile !== "object") return { userInfo: {}, videos: [] };

  const videos = (profile.videoList || []).filter(
    (v: any) => v && typeof v === "object" && v.id,
  );
  // Video ids are time-ordered, so sorting descending guarantees newest-first.
  videos.sort((a: any, b: any) => (BigInt(a.id) < BigInt(b.id) ? 1 : -1));
  return { userInfo: profile.userInfo || {}, videos };
}

/** Convert an embed entry into the aweme shape `normalizeVideo` expects. */
export function embedItemToAweme(item: any): any {
  return {
    id: item.id,
    desc: item.desc || "",
    author: { uniqueId: item.authorUniqueId || "" },
    video: {
      cover: item.coverUrl || "",
      originCover: item.originCoverUrl || "",
      dynamicCover: item.dynamicCoverUrl || "",
      width: item.width,
      height: item.height,
      ratio: item.ratio,
    },
    stats: { playCount: item.playCount },
  };
}

// ------------------------------------------------------------ normalising

function textParts(item: any): { hashtags: string[]; mentions: string[] } {
  const hashtags: string[] = [];
  const mentions: string[] = [];

  for (const extra of item.textExtra || []) {
    if (!extra || typeof extra !== "object") continue;
    if (extra.type === 1 && extra.hashtagName) {
      const name = String(extra.hashtagName).trim();
      if (name && !hashtags.includes(name)) hashtags.push(name);
    } else if (extra.type === 2 && (extra.uniqueId || extra.userId)) {
      const id = String(extra.uniqueId || extra.userId).trim();
      if (id && !mentions.includes(id)) mentions.push(id);
    }
  }

  const caption = String(item.desc || "");
  if (!hashtags.length) {
    for (const match of caption.matchAll(HASHTAG_RE)) {
      const tag = match[1];
      if (tag && tag.toLowerCase() !== "fyp" && !hashtags.includes(tag)) hashtags.push(tag);
    }
  }
  if (!mentions.length) {
    for (const match of caption.matchAll(MENTION_RE)) {
      const mention = match[1];
      if (mention && !mentions.includes(mention)) mentions.push(mention);
    }
  }
  return { hashtags, mentions };
}

function videoStats(item: any): Record<string, number | null> {
  const v2 = item.statsV2 || {};
  const base = item.stats || {};
  const pick = (name: string): number | null =>
    parseNumber(v2[name] !== undefined ? v2[name] : base[name]);

  return {
    likes: pick("diggCount"),
    comments: pick("commentCount"),
    shares: pick("shareCount"),
    saves: pick("collectCount"),
    plays: pick("playCount"),
    reposts: pick("repostCount"),
  };
}

function authorStats(item: any) {
  const stats = item.authorStats || {};
  const v2 = item.authorStatsV2 || {};
  const pick = (name: string): number | null =>
    parseNumber(stats[name] !== undefined ? stats[name] : v2[name]);

  return {
    followers: pick("followerCount"),
    following: pick("followingCount"),
    videoCount: pick("videoCount"),
    hearts: pick("heart"),
  };
}

function isoDate(timestamp: number | null): { iso: string; date: string; hour: string; weekday: string } {
  if (!timestamp) return { iso: "", date: "", hour: "", weekday: "" };
  const date = new Date(timestamp * 1000);
  if (Number.isNaN(date.getTime())) return { iso: "", date: "", hour: "", weekday: "" };
  const days = [
    "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday",
  ];
  return {
    iso: date.toISOString(),
    date: date.toISOString().slice(0, 10),
    hour: String(date.getUTCHours()),
    weekday: days[date.getUTCDay()],
  };
}

/** Turn a raw TikTok aweme object into a flat record. */
export function normalizeVideo(
  item: any,
  sourceUrl: string,
  discoveryMode: string,
  scrapedAt: string,
): VideoRecord {
  const author = item.author || {};
  const music = item.music || {};
  const video = item.video || {};
  const videoId = String(item.id || item.aweme_id || "");
  const handle = String(author.uniqueId || "");
  const caption = String(item.desc || "");
  const { hashtags, mentions } = textParts(item);
  const stats = videoStats(item);
  const creator = authorStats(item);
  const when = isoDate(parseNumber(item.createTime));

  for (const challenge of item.challenges || []) {
    const title = challenge?.title ? String(challenge.title) : "";
    if (title && !hashtags.some((h) => h.toLowerCase() === title.toLowerCase())) {
      hashtags.push(title);
    }
  }

  const num = (value: number | null): number | string => (value === null ? "" : value);

  return {
    video_id: videoId,
    url: handle
      ? `https://www.tiktok.com/@${handle}/video/${videoId}`
      : `https://www.tiktok.com/video/${videoId}`,
    source_url: sourceUrl,
    discovery_mode: discoveryMode,
    author_handle: handle,
    author_id: String(author.id || ""),
    author_nickname: String(author.nickname || ""),
    author_verified: author.verified ? "True" : "False",
    author_followers: num(creator.followers),
    author_following: num(creator.following),
    author_video_count: num(creator.videoCount),
    author_heart_count: num(creator.hearts),
    author_bio: String(author.signature || ""),
    author_avatar: String(author.avatarLarger || author.avatarMedium || ""),
    caption,
    hashtags: hashtags.join(","),
    hashtag_count: hashtags.length,
    mentions: mentions.join(","),
    sound_id: String(music.id || ""),
    sound_title: String(music.title || ""),
    sound_author: String(music.authorName || music.author || ""),
    sound_is_original: music.original ? "True" : "False",
    sound_duration: num(parseNumber(music.duration)),
    likes: num(stats.likes),
    comments: num(stats.comments),
    shares: num(stats.shares),
    saves: num(stats.saves),
    plays: num(stats.plays),
    reposts: num(stats.reposts),
    create_time: item.createTime ? String(item.createTime) : "",
    create_date: when.date,
    create_hour: when.hour,
    create_weekday: when.weekday,
    location_created: String(item.locationCreated || ""),
    duration_seconds: num(parseNumber(video.duration)),
    width: num(parseNumber(video.width)),
    height: num(parseNumber(video.height)),
    cover_url: String(video.cover || video.originCover || video.dynamicCover || ""),
    video_language: String(item.textLanguage || ""),
    is_ad: item.isAd ? "True" : "False",
    is_pinned: item.isPinnedItem ? "True" : "False",
    is_aigc: item.IsAigc ? "True" : "False",
    scraped_at: scrapedAt,
    status: "ok",
    status_message: "",
  };
}

/** Turn a raw TikTok profile object into a flat record. */
export function normalizeProfile(
  user: any,
  stats: any,
  handle: string,
  sourceUrl: string,
  scrapedAt: string,
): ProfileRecord {
  const uniqueId = String(user.uniqueId || handle.replace(/^@/, ""));
  const profileUrl = `https://www.tiktok.com/@${uniqueId}`;

  let totalLikes = parseNumber(stats.heart) ?? 0;
  if (totalLikes <= 0) totalLikes = parseNumber(stats.heartCount) ?? 0;

  let bioLink = "";
  if (user.bioLink && typeof user.bioLink === "object") {
    bioLink = String(user.bioLink.link || "");
  } else if (typeof user.bioLink === "string") {
    bioLink = user.bioLink;
  }

  const when = isoDate(parseNumber(user.createTime));
  const num = (value: number | null): number | string => (value === null ? "" : value);

  return {
    handle: uniqueId,
    profile_url: profileUrl,
    source_url: sourceUrl || profileUrl,
    user_id: String(user.id || ""),
    sec_uid: String(user.secUid || ""),
    nickname: String(user.nickname || ""),
    bio: String(user.signature || ""),
    bio_link: bioLink,
    avatar_large: String(user.avatarLarger || ""),
    avatar_medium: String(user.avatarMedium || ""),
    avatar_thumb: String(user.avatarThumb || ""),
    verified: user.verified ? "True" : "False",
    is_private: user.privateAccount ? "True" : "False",
    follower_count: num(parseNumber(stats.followerCount)),
    following_count: num(parseNumber(stats.followingCount)),
    video_count: num(parseNumber(stats.videoCount)),
    total_likes: totalLikes,
    friend_count: num(parseNumber(stats.friendCount)),
    account_created: when.iso,
    account_created_date: when.date,
    language: String(user.language || ""),
    show_music_tab: user.profileTab?.showMusicTab ? "True" : "False",
    has_bio_link: bioLink ? "True" : "False",
    scraped_at: scrapedAt,
    status: "ok",
    status_message: "",
  };
}

/** A failed video row, so callers can report a true success rate. */
export function failedVideo(
  url: string,
  reason: string,
  scrapedAt: string,
): VideoRecord {
  const match = /\/video\/(\d+)/.exec(url || "");
  return {
    video_id: match ? match[1] : "",
    url,
    source_url: url,
    discovery_mode: "url",
    author_handle: "",
    author_id: "",
    author_nickname: "",
    author_verified: "",
    author_followers: "",
    author_following: "",
    author_video_count: "",
    author_heart_count: "",
    author_bio: "",
    author_avatar: "",
    caption: "",
    hashtags: "",
    hashtag_count: "",
    mentions: "",
    sound_id: "",
    sound_title: "",
    sound_author: "",
    sound_is_original: "",
    sound_duration: "",
    likes: "",
    comments: "",
    shares: "",
    saves: "",
    plays: "",
    reposts: "",
    create_time: "",
    create_date: "",
    create_hour: "",
    create_weekday: "",
    location_created: "",
    duration_seconds: "",
    width: "",
    height: "",
    cover_url: "",
    video_language: "",
    is_ad: "",
    is_pinned: "",
    is_aigc: "",
    scraped_at: scrapedAt,
    status: "failed",
    status_message: reason,
  };
}

/** A failed profile row. */
export function failedProfile(
  handle: string,
  reason: string,
  scrapedAt: string,
  status = "failed",
): ProfileRecord {
  const clean = String(handle || "").replace(/^@/, "");
  return {
    handle: clean,
    profile_url: clean ? `https://www.tiktok.com/@${clean}` : "",
    source_url: clean ? `https://www.tiktok.com/@${clean}` : "",
    user_id: "",
    sec_uid: "",
    nickname: "",
    bio: "",
    bio_link: "",
    avatar_large: "",
    avatar_medium: "",
    avatar_thumb: "",
    verified: "",
    is_private: "",
    follower_count: "",
    following_count: "",
    video_count: "",
    total_likes: "",
    friend_count: "",
    account_created: "",
    account_created_date: "",
    language: "",
    show_music_tab: "",
    has_bio_link: "",
    scraped_at: scrapedAt,
    status,
    status_message: reason,
  };
}

/**
 * Run tasks with a bounded number in flight.
 *
 * Fetching 20 video pages one after another takes ~20 round trips and blows
 * past any sensible timeout. With a small pool the same work finishes in a
 * couple of round trips.
 */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
  delayMs = 0,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const width = Math.max(1, Math.min(limit, items.length));

  const workers = Array.from({ length: width }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      if (delayMs > 0 && index > 0) await sleep(delayMs);
      results[index] = await fn(items[index], index);
    }
  });

  await Promise.all(workers);
  return results;
}
