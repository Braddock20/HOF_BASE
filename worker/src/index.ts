/**
 * tiktok-scraper Worker
 * ---------------------
 * Collects public TikTok video and creator-profile metadata from the edge.
 *
 * Endpoints
 *   GET  /                      service description + usage
 *   GET  /api/health            liveness probe
 *   GET  /api/video?url=...     one video's metadata
 *   GET  /api/profile?handle=.. one creator's public profile
 *   GET  /api/profile/posts?handle=..  a creator's recent posts (newest first)
 *   GET  /api/scrape?urls=a,b&handles=c,d   batch (query form)
 *   POST /api/scrape            batch {"urls": [...], "handles": [...]}
 *
 * Every endpoint accepts `?format=json` (default) or `?format=csv`.
 *
 * Design notes
 *   - Video URLs and creator profiles come from TikTok's server-rendered
 *     pages, so no browser is needed.
 *   - A creator's recent posts come from the public embed page, which is
 *     the only surface that lists them without a signed API request.
 *   - Video detail pages are fetched in parallel with a small pool, and
 *     every page is cached in the Cloudflare cache, so the every-5-minute
 *     sync does not re-download the same pages.
 *   - TikTok throttles per IP and signals it with 429, 5xx, or - the trap -
 *     HTTP 400 with the body "ratelimit triggered". All three are retried.
 */

import {
  embedItemToAweme,
  embedProfile,
  extractProfile,
  extractVideoItem,
  failedProfile,
  failedVideo,
  fetchPage,
  mapLimit,
  normalizeProfile,
  normalizeVideo,
  TikTokError,
} from "./tiktok";
import { PROFILE_FIELDS, ProfileRecord, VIDEO_FIELDS, VideoRecord } from "./types";

interface Env {
  /** Optional shared secret. When set, requests must send it. */
  API_KEY?: string;
  /** Cache lifetime for TikTok pages, seconds. */
  CACHE_TTL_SECONDS?: string;
  /** How many video detail pages to fetch at once. */
  DETAIL_CONCURRENCY?: string;
}

const VERSION = "2.0.0";

const MAX_ITEMS = 40;
const MAX_PROFILE_POSTS = 40;
const DEFAULT_DELAY_MS = 1000;
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_POST_LIMIT = 20;
/** TikTok pages are big; the worker should not spend minutes on one account. */
const PAGE_BUDGET_MS = 25_000;

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-API-Key",
  "Access-Control-Max-Age": "86400",
};

function json(data: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...CORS_HEADERS,
      ...extra,
    },
  });
}

function csv(rows: Record<string, unknown>[], fields: string[]): Response {
  const escape = (value: unknown): string => {
    const text = value === null || value === undefined ? "" : String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const lines = [fields.join(",")];
  for (const row of rows) {
    lines.push(fields.map((field) => escape(row[field])).join(","));
  }
  return new Response(lines.join("\n"), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="tiktok_metadata.csv"',
      ...CORS_HEADERS,
    },
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Build the canonical TikTok URL for a handle without mangling odd handles.
 *
 * TikTok handles are always lower-case; a request with a capital letter is
 * answered as "no such account". Callers often pass a handle as typed, so
 * it is normalised here while the original spelling is kept for display.
 */
function profileUrl(handle: string): string {
  return `https://www.tiktok.com/@${encodeURIComponent(handle.replace(/^@/, "").trim().toLowerCase())}`;
}

function embedUrl(handle: string): string {
  return `https://www.tiktok.com/embed/@${encodeURIComponent(handle.replace(/^@/, "").trim().toLowerCase())}`;
}

function cacheTtl(env: Env): number {
  const value = Number(env.CACHE_TTL_SECONDS);
  return Number.isFinite(value) && value >= 0 ? value : 300;
}

function detailConcurrency(env: Env): number {
  const value = Number(env.DETAIL_CONCURRENCY);
  if (!Number.isFinite(value) || value < 1) return 6;
  return Math.min(10, Math.max(1, Math.floor(value)));
}

/** Collect a video's metadata. */
async function scrapeVideo(
  url: string,
  language: string,
  env: Env,
  ctx: ExecutionContext,
): Promise<VideoRecord> {
  const scrapedAt = new Date().toISOString();
  try {
    const html = await fetchPage(url, {
      language,
      ctx,
      cacheTtl: cacheTtl(env),
      cacheTag: "tiktok-video",
    });
    const { item, message } = extractVideoItem(html);
    if (!item) return failedVideo(url, message || "unavailable", scrapedAt);
    return normalizeVideo(item, url, "url", scrapedAt);
  } catch (error) {
    const message = error instanceof TikTokError ? error.message : String(error);
    return failedVideo(url, message, scrapedAt);
  }
}

/** Collect a creator's public profile details. */
async function scrapeProfile(
  handle: string,
  language: string,
  env: Env,
  ctx: ExecutionContext,
): Promise<ProfileRecord> {
  const scrapedAt = new Date().toISOString();
  const clean = handle.replace(/^@/, "").trim();
  const url = profileUrl(clean);
  try {
    const html = await fetchPage(url, {
      language,
      ctx,
      cacheTtl: cacheTtl(env),
      cacheTag: "tiktok-profile",
    });
    const { user, stats, message, statusCode } = extractProfile(html, clean);
    if (!user) {
      // 10221 = gone, 209002 = restricted. Both are worth saying out loud.
      const status =
        statusCode === 10221 ? "not_found" : statusCode === 209002 ? "restricted" : "failed";
      return failedProfile(clean, message || "unavailable", scrapedAt, status);
    }
    return normalizeProfile(user, stats, clean, url, scrapedAt);
  } catch (error) {
    if (error instanceof TikTokError && error.kind === "not_found") {
      return failedProfile(clean, error.message, scrapedAt, "not_found");
    }
    if (error instanceof TikTokError && error.kind === "rate_limited") {
      return failedProfile(clean, error.message, scrapedAt, "rate_limited");
    }
    if (error instanceof TikTokError && error.kind === "restricted") {
      return failedProfile(clean, error.message, scrapedAt, "restricted");
    }
    return failedProfile(
      clean,
      error instanceof Error ? error.message : String(error),
      scrapedAt,
      "failed",
    );
  }
}

/**
 * Collect a creator's recent posts, newest first.
 *
 * Discovery uses the public embed page; each video's full metadata then
 * comes from its detail page. The detail pages are fetched in parallel,
 * because doing them one by one is what made this endpoint slow.
 */
async function scrapeProfilePosts(
  handle: string,
  limit: number,
  language: string,
  env: Env,
  ctx: ExecutionContext,
): Promise<{
  videos: VideoRecord[];
  userInfo: any;
  status: string;
  warning: string | null;
}> {
  const scrapedAt = new Date().toISOString();
  const clean = handle.replace(/^@/, "").trim();
  const deadline = Date.now() + PAGE_BUDGET_MS;

  // The profile page tells us whether the account exists at all, how many
  // videos it claims to have, and gives the creator's public details for
  // free. It runs alongside the embed page so the two costs overlap instead
  // of stacking.
  const profilePromise = fetchPage(profileUrl(clean), {
    language,
    ctx,
    cacheTtl: cacheTtl(env),
    cacheTag: "tiktok-profile",
  });

  let discovered: any[] = [];
  let userInfo: any = {};
  let embedError: TikTokError | null = null;

  const embedHtmlPromise = fetchPage(embedUrl(clean), {
    language,
    ctx,
    cacheTtl: cacheTtl(env),
    cacheTag: "tiktok-embed",
  });

  try {
    const embedHtml = await embedHtmlPromise;
    const found = embedProfile(embedHtml, clean);
    userInfo = found.userInfo;
    discovered = found.videos;
  } catch (error) {
    embedError = error instanceof TikTokError ? error : new TikTokError("error", String(error));
  }

  // Profile problems (gone, restricted) explain the embed failure better
  // than the embed failure explains itself.
  let profileVideoCount: number | null = null;
  try {
    const profileHtml = await profilePromise;
    const { user, stats, message, statusCode } = extractProfile(profileHtml, clean);
    if (!user) {
      const kind =
        statusCode === 10221 ? "not_found" : statusCode === 209002 ? "restricted" : embedError?.kind;
      if (kind) {
        embedError = new TikTokError(
          kind as TikTokError["kind"],
          message || "profile unavailable",
          statusCode ?? 0,
        );
      }
    } else {
      profileVideoCount = Number(stats?.videoCount ?? 0) || null;
      if (!userInfo?.uniqueId) userInfo = userInfo || {};
    }
  } catch (error) {
    if (embedError === null && error instanceof TikTokError) embedError = error;
  }

  if (!discovered.length) {
    // A soft throttle: TikTok sometimes answers the embed page with HTTP 200
    // and an empty list instead of an error. If the profile page says the
    // account has videos, that is what happened - so ask again.
    if (embedError === null && profileVideoCount && profileVideoCount > 0) {
      for (let attempt = 0; attempt < 2 && discovered.length === 0; attempt++) {
        await sleep(1200 * (attempt + 1));
        try {
          const retryHtml = await fetchPage(embedUrl(clean), {
            language,
            ctx,
            cacheTtl: 0,
            cacheTag: "tiktok-embed",
          });
          const found = embedProfile(retryHtml, clean);
          userInfo = found.userInfo;
          discovered = found.videos;
        } catch {
          // Keep the previous outcome; the warning below explains it.
        }
      }
    }
  }

  if (!discovered.length) {
    const kind = embedError?.kind ?? "empty";
    const status =
      kind === "not_found"
        ? "not_found"
        : kind === "restricted"
          ? "restricted"
          : kind === "rate_limited"
            ? "rate_limited"
            : "empty";
    let warning =
      kind === "empty"
        ? "no public posts were listed for this account"
        : (embedError?.message ?? "no public posts were listed for this account");
    if (kind === "empty" && profileVideoCount && profileVideoCount > 0) {
      warning = `account reports ${profileVideoCount} videos but TikTok listed none (posts may be hidden or newly restricted)`;
    }
    return { videos: [], userInfo, status, warning };
  }

  const targets = discovered.slice(0, limit);
  const videos = await mapLimit(targets, detailConcurrency(env), async (item: any) => {
    const author = item.authorUniqueId || clean;
    const url = `https://www.tiktok.com/@${encodeURIComponent(author)}/video/${item.id}`;
    if (Date.now() > deadline) {
      const partial = normalizeVideo(embedItemToAweme(item), url, "user", scrapedAt);
      partial.status = "partial";
      partial.status_message = "time budget exhausted before this video was read";
      return partial;
    }
    try {
      const html = await fetchPage(url, {
        language,
        ctx,
        cacheTtl: cacheTtl(env),
        cacheTag: "tiktok-video",
      });
      const { item: aweme, message } = extractVideoItem(html);
      if (!aweme) {
        const partial = normalizeVideo(embedItemToAweme(item), url, "user", scrapedAt);
        partial.status = "partial";
        partial.status_message = message || "detail page unreadable";
        return partial;
      }
      return normalizeVideo(aweme, url, "user", scrapedAt);
    } catch (error) {
      // Never lose a video just because its detail page was blocked: the
      // embed payload still gives id, caption, cover and view count.
      const partial = normalizeVideo(embedItemToAweme(item), url, "user", scrapedAt);
      partial.status = "partial";
      partial.status_message =
        error instanceof TikTokError ? error.message : String(error);
      return partial;
    }
  });

  return { videos, userInfo, status: "ok", warning: null };
}

function splitList(value: string | null): string[] {
  if (!value) return [];
  return value
    .split(/[,\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

const USAGE = {
  name: "tiktok-scraper worker",
  version: VERSION,
  description:
    "Collects public TikTok video and creator-profile metadata. Public data only.",
  endpoints: {
    "GET /api/health": "liveness probe",
    "GET /api/video?url=<video url>": "one video's metadata",
    "GET /api/profile?handle=<handle>": "one creator's profile",
    "GET /api/profile/posts?handle=<handle>": "a creator's recent posts (newest first)",
    "GET /api/scrape?urls=<a,b>&handles=<c,d>": "batch",
    "POST /api/scrape": 'batch with body {"urls": [], "handles": []}',
  },
  parameters: {
    format: "json (default) or csv",
    delayMs: `pause between requests, default ${DEFAULT_DELAY_MS}`,
    concurrency: `parallel requests, default ${DEFAULT_CONCURRENCY}`,
    limit: `max posts for /api/profile/posts, default ${DEFAULT_POST_LIMIT}`,
    lang: "Accept-Language header, default en-US",
  },
  limits: {
    max_items_per_request: MAX_ITEMS,
    max_profile_posts: MAX_PROFILE_POSTS,
    note:
      "Hashtag discovery needs a browser and is not available on Workers - " +
      "use the Python tool for that, then pass URLs here.",
  },
  status_values: {
    ok: "the request succeeded",
    partial: "some rows are missing detail; see status_message",
    empty: "the account exists but lists no public posts",
    not_found: "the account does not exist (TikTok errorCode 10221)",
    restricted: "TikTok blocks this account (errorCode 10101 / 209002)",
    rate_limited: "TikTok throttled the request; retry later",
    failed: "unexpected failure; see status_message",
  },
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (env.API_KEY) {
      const provided =
        request.headers.get("X-API-Key") ||
        request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") ||
        url.searchParams.get("key");
      if (provided !== env.API_KEY) {
        return json({ error: "unauthorized" }, 401);
      }
    }

    const language = url.searchParams.get("lang") || "en-US";
    const format = (url.searchParams.get("format") || "json").toLowerCase();
    const cf = (request as any)?.cf ?? (ctx as any)?.cf ?? {};

    // ---- health & usage --------------------------------------------
    if (url.pathname === "/api/health") {
      return json({
        ok: true,
        version: VERSION,
        time: new Date().toISOString(),
        colo: cf.colo ?? null,
        country: cf.country ?? null,
      });
    }

    if (url.pathname === "/" || url.pathname === "/api") {
      return json(USAGE);
    }

    // ---- single video ------------------------------------------------
    if (url.pathname === "/api/video") {
      const target = url.searchParams.get("url");
      if (!target) return json({ error: "missing ?url=" }, 400);
      const record = await scrapeVideo(target, language, env, ctx);
      if (format === "csv") {
        return csv([record as unknown as Record<string, unknown>], VIDEO_FIELDS as string[]);
      }
      return json(record);
    }

    // ---- single profile ----------------------------------------------
    if (url.pathname === "/api/profile") {
      const handle = url.searchParams.get("handle") || url.searchParams.get("user");
      if (!handle) return json({ error: "missing ?handle=" }, 400);
      const record = await scrapeProfile(handle, language, env, ctx);
      if (format === "csv") {
        return csv([record as unknown as Record<string, unknown>], PROFILE_FIELDS as string[]);
      }
      return json(record);
    }

    // ---- a creator's recent posts ------------------------------------
    if (url.pathname === "/api/profile/posts") {
      const handle = url.searchParams.get("handle") || url.searchParams.get("user");
      if (!handle) return json({ error: "missing ?handle=" }, 400);
      const limit = Math.min(
        Math.max(1, Number(url.searchParams.get("limit")) || DEFAULT_POST_LIMIT),
        MAX_PROFILE_POSTS,
      );
      const result = await scrapeProfilePosts(handle, limit, language, env, ctx);
      if (format === "csv") {
        return csv(
          result.videos as unknown as Record<string, unknown>[],
          VIDEO_FIELDS as string[],
        );
      }
      const ok = result.videos.filter((v) => v.status === "ok").length;
      const partial = result.videos.filter((v) => v.status === "partial").length;
      return json({
        handle: handle.replace(/^@/, ""),
        videos: result.videos,
        user_info: result.userInfo,
        status: result.status,
        meta: {
          requested: limit,
          returned: result.videos.length,
          ok,
          partial,
          scraped_at: new Date().toISOString(),
          colo: cf.colo ?? null,
        },
        ...(result.warning ? { warning: result.warning } : {}),
      });
    }

    // ---- batch --------------------------------------------------------
    if (url.pathname === "/api/scrape") {
      let urls: string[] = splitList(url.searchParams.get("urls"));
      let handles: string[] = splitList(url.searchParams.get("handles"));

      if (request.method === "POST") {
        try {
          const body = (await request.json()) as {
            urls?: unknown;
            handles?: unknown;
          } | null;
          if (body && Array.isArray(body.urls)) urls = body.urls.map(String);
          if (body && Array.isArray(body.handles)) handles = body.handles.map(String);
        } catch {
          return json({ error: "invalid JSON body" }, 400);
        }
      }

      const total = urls.length + handles.length;
      if (total === 0) {
        return json({ error: "provide urls and/or handles" }, 400);
      }
      if (total > MAX_ITEMS) {
        return json(
          { error: `too many items: ${total} (max ${MAX_ITEMS} per request)` },
          400,
        );
      }

      const delayMs = Number(url.searchParams.get("delayMs")) || DEFAULT_DELAY_MS;
      const concurrency = Number(url.searchParams.get("concurrency")) || DEFAULT_CONCURRENCY;

      const videoTasks = urls.map((target) => () => scrapeVideo(target, language, env, ctx));
      const profileTasks = handles.map((handle) => () => scrapeProfile(handle, language, env, ctx));

      const [videos, profiles] = await Promise.all([
        mapLimit(videoTasks, concurrency, (task) => task(), delayMs),
        mapLimit(profileTasks, concurrency, (task) => task(), delayMs),
      ]);

      const okVideos = videos.filter((v) => v.status === "ok").length;
      const okProfiles = profiles.filter((p) => p.status === "ok").length;

      if (format === "csv") {
        if (profiles.length && !urls.length) {
          return csv(
            profiles as unknown as Record<string, unknown>[],
            PROFILE_FIELDS as string[],
          );
        }
        return csv(videos as unknown as Record<string, unknown>[], VIDEO_FIELDS as string[]);
      }

      return json({
        videos,
        profiles,
        meta: {
          requested: total,
          video_count: videos.length,
          profile_count: profiles.length,
          ok: okVideos + okProfiles,
          failed: total - okVideos - okProfiles,
          scraped_at: new Date().toISOString(),
          colo: cf.colo ?? null,
        },
      });
    }

    return json({ error: "not found", endpoints: Object.keys(USAGE.endpoints) }, 404);
  },
};
