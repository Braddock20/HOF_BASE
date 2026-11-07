import type { Env } from "./types";
import { db } from "./db";
import { discoverTikTok, normalizeTikTok, scraperFetch } from "./tiktok";
import { refreshDueCreators } from "./creator-sync";
import { b2Configured, uploadPrivateB2Object } from "./b2";

type SocialAccount = {
  id: string;
  username: string;
  platformUserId: string | null;
  displayName: string | null;
  oldVideoCount: number | string | null;
  lastPostSyncAt: string | null;
  storedPosts?: number | string | null;
};

const first = (value: any, keys: string[]) => {
  for (const key of keys) if (value?.[key] !== undefined && value[key] !== null) return value[key];
  return null;
};

function nonNegativeInteger(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function nonNegativeDecimal(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.min(parsed, 86400) : null;
}

function normalizedHandle(value: unknown): string {
  return String(value ?? "").trim().replace(/^@/, "").toLowerCase();
}

function safeTikTokPostUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== "https:" || !["tiktok.com", "www.tiktok.com", "m.tiktok.com", "vm.tiktok.com", "vt.tiktok.com"].includes(host)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function safeCoverUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 4096) return null;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    const allowed = ["tiktokcdn.com", "tiktokcdn-us.com", "tiktokcdn-eu.com", "tiktokcdn-in.com", "tiktokcdn.net", "tiktokv.com"];
    if (url.protocol !== "https:" || !allowed.some(domain => host === domain || host.endsWith(`.${domain}`))) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function parseHashtags(value: unknown): string[] {
  const source = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[,,\s]+/) : [];
  return [...new Set(source.map(item => String(item).trim().replace(/^#/, "").replace(/[^\p{L}\p{N}_]/gu, "").slice(0, 100)).filter(Boolean))].slice(0, 100);
}

function metricValues(video: any) {
  return {
    likes: nonNegativeInteger(first(video, ["likes", "digg_count"])),
    comments: nonNegativeInteger(first(video, ["comments", "comment_count"])),
    shares: nonNegativeInteger(first(video, ["shares", "share_count"])),
    saves: nonNegativeInteger(first(video, ["saves", "collect_count"])),
    plays: nonNegativeInteger(first(video, ["plays", "play_count", "view_count"])),
    reposts: nonNegativeInteger(first(video, ["reposts", "repost_count"]))
  };
}

function hasAnyMetric(metrics: ReturnType<typeof metricValues>): boolean {
  return Object.values(metrics).some(value => value !== null);
}

async function cacheCover(env: Env, coverUrl: string, videoId: string): Promise<string | null> {
  if (!b2Configured(env)) return null;
  const url = safeCoverUrl(coverUrl);
  if (!url) return null;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000), redirect: "manual" });
    if (!response.ok) return null;
    const mimeType = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    const allowedTypes: Record<string, string> = {
      "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif"
    };
    const extension = allowedTypes[mimeType];
    if (!extension) return null;
    const blob = await response.blob();
    if (blob.size === 0 || blob.size > 5 * 1024 * 1024) return null;
    const safeId = videoId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 160);
    const objectKey = `tiktok/thumbnails/${safeId}.${extension}`;
    const file = new File([blob], `${safeId}.${extension}`, { type: mimeType });
    const stored = await uploadPrivateB2Object(env, objectKey, file);
    const rows = await db(env).query<{ id: string }>(`INSERT INTO hof_media_assets
      (object_key,b2_file_id,mime_type,file_size,checksum_sha1,status,visibility)
      VALUES($1,$2,$3,$4,$5,'ready','public')
      ON CONFLICT(object_key) DO UPDATE SET b2_file_id=EXCLUDED.b2_file_id,
        mime_type=EXCLUDED.mime_type,file_size=EXCLUDED.file_size,checksum_sha1=EXCLUDED.checksum_sha1,
        status='ready',visibility='public',deleted_at=NULL
      RETURNING id`, [objectKey, stored.fileId, stored.mimeType, stored.size, stored.sha1]);
    return rows[0]?.id ?? null;
  } catch {
    // A cover-cache failure must not prevent importing the source post.
    return null;
  }
}

function parsePublishedAt(video: any): string | null {
  const raw = first(video, ["create_time", "createTime"]);
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 4_102_444_800) return null;
  const date = new Date(seconds * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

async function pullPosts(env: Env, account: SocialAccount) {
  if (!env.TIKTOK_SCRAPER_BASE_URL || !env.TIKTOK_POSTS_PATH) throw new Error("TikTok posts endpoint is not configured");
  const base = new URL(env.TIKTOK_SCRAPER_BASE_URL);
  if (base.protocol !== "https:") throw new Error("TikTok scraper URL must use HTTPS");
  const url = new URL(env.TIKTOK_POSTS_PATH, `${base.toString().replace(/\/+$/, "")}/`);
  url.searchParams.set("handle", account.username.replace(/^@/, ""));
  const headers = new Headers({ Accept: "application/json" });
  const response = await scraperFetch(env, url, { headers, signal: AbortSignal.timeout(25_000), redirect: "manual" });
  if (response.status === 429) throw new Error("TikTok posts provider is rate limited");
  if (!response.ok) throw new Error(`TikTok posts provider returned ${response.status}`);
  const raw = await response.json() as any;
  const root = raw?.data && typeof raw.data === "object" ? raw.data : raw;
  const videos = Array.isArray(root?.videos) ? root.videos : Array.isArray(raw?.videos) ? raw.videos : null;
  if (!videos) throw new Error("TikTok posts provider returned an invalid response");
  // An empty list is only a valid success when the account really has no videos.
  // The scraper answers HTTP 200 with videos:[] plus a warning when TikTok blocks it,
  // so treat that as a failure and let the job retry instead of marking it done.
  if (videos.length === 0) {
    const warning = typeof raw?.warning === "string" ? raw.warning : (typeof root?.warning === "string" ? root.warning : "");
    const expected = nonNegativeInteger(account.oldVideoCount);
    if (warning || (expected !== null && expected > 0)) {
      throw new Error(`TikTok posts provider returned no videos${warning ? `: ${warning}` : ` (profile reports ${expected})`}`.slice(0, 300));
    }
  }

  const query = db(env);
  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  let snapshots = 0;
  const reasons: Record<string, number> = {};
  const skip = (reason: string) => { skipped++; reasons[reason] = (reasons[reason] || 0) + 1; };

  for (const video of videos) {
    const sourcePostId = String(first(video, ["video_id", "id"]) ?? "").trim();
    const sourceUrl = safeTikTokPostUrl(first(video, ["source_url", "url"]));
    const status = String(video?.status ?? "ok").toLowerCase();
    const isAd = String(video?.is_ad ?? "false").toLowerCase() === "true" || video?.is_ad === 1;
    const skipReason = !sourcePostId || sourcePostId.length > 200 ? "no_id" : !sourceUrl ? "bad_url"
      : status !== "ok" ? `status_${status}`.slice(0, 40) : isAd ? "ad" : "";
    if (skipReason) {
      skip(skipReason);
      continue;
    }

    // The posts endpoint is queried for one handle, but we still verify each
    // returned video's author before attaching it to an HOF creator.
    const authorHandle = normalizedHandle(first(video, ["author_handle", "author_username", "handle"]));
    const authorIdValue = first(video, ["author_id", "author_user_id", "author_uid"]);
    const authorId = authorIdValue === null ? null : String(authorIdValue);
    const expectedHandle = normalizedHandle(account.username);
    const authorMatches = (authorHandle && authorHandle === expectedHandle) || (authorId && account.platformUserId && authorId === account.platformUserId);
    const authorPresent = Boolean(authorHandle || authorId);
    // The request was for this one handle, so a video with no author fields is accepted; a video naming another author is not.
    if (authorPresent && !authorMatches) {
      skip("other_author");
      continue;
    }
    if (authorId && account.platformUserId && authorId !== account.platformUserId) {
      skip("other_author_id");
      continue;
    }

    const tombstone = await query.query("SELECT 1 FROM hof_deleted_source_posts WHERE source='tiktok' AND source_post_id=$1", [sourcePostId]);
    if (tombstone.length) {
      skip("deleted");
      continue;
    }

    const metrics = metricValues(video);
    const hashtags = parseHashtags(video.hashtags);
    const caption = typeof video.caption === "string" ? video.caption.slice(0, 5000) : null;
    const coverUrl = safeCoverUrl(first(video, ["cover_url", "origin_cover", "dynamic_cover"]));
    const existing = await query.query<{ thumbnailMediaId: string | null; creatorSocialAccountId: string | null }>(
      `SELECT thumbnail_media_id AS "thumbnailMediaId",creator_social_account_id AS "creatorSocialAccountId"
       FROM hof_discover_posts WHERE source='tiktok' AND source_post_id=$1`, [sourcePostId]);
    if (existing[0]?.creatorSocialAccountId && existing[0].creatorSocialAccountId !== account.id) {
      skip("owned_by_other_creator");
      continue;
    }
    const thumbnailMediaId = existing[0]?.thumbnailMediaId || (coverUrl ? await cacheCover(env, coverUrl, sourcePostId) : null);
    const publishedAt = parsePublishedAt(video);
    const duration = nonNegativeDecimal(first(video, ["duration_seconds", "duration"]));
    const width = nonNegativeInteger(video.width);
    const height = nonNegativeInteger(video.height);
    const result = await query.query<{ id: string; inserted: boolean }>(`INSERT INTO hof_discover_posts(
        source,source_post_id,source_url,creator_social_account_id,creator_name,creator_handle,caption,hashtags,
        media_type,external_thumbnail_url,thumbnail_media_id,duration_seconds,width,height,published_at,
        likes,comments,shares,saves,plays,reposts,source_payload,status,visibility)
      VALUES('tiktok',$1,$2,$3,$4,$5,$6,$7,'video',$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20::jsonb,'approved','public')
      ON CONFLICT(source,source_post_id) DO UPDATE SET
        creator_social_account_id=COALESCE(hof_discover_posts.creator_social_account_id,EXCLUDED.creator_social_account_id),
        source_url=COALESCE(EXCLUDED.source_url,hof_discover_posts.source_url),
        creator_name=COALESCE(hof_discover_posts.creator_name,EXCLUDED.creator_name),
        creator_handle=COALESCE(hof_discover_posts.creator_handle,EXCLUDED.creator_handle),
        caption=COALESCE(EXCLUDED.caption,hof_discover_posts.caption),
        hashtags=CASE WHEN cardinality(EXCLUDED.hashtags)>0 THEN EXCLUDED.hashtags ELSE hof_discover_posts.hashtags END,
        external_thumbnail_url=COALESCE(EXCLUDED.external_thumbnail_url,hof_discover_posts.external_thumbnail_url),
        thumbnail_media_id=COALESCE(hof_discover_posts.thumbnail_media_id,EXCLUDED.thumbnail_media_id),
        duration_seconds=COALESCE(EXCLUDED.duration_seconds,hof_discover_posts.duration_seconds),
        width=COALESCE(EXCLUDED.width,hof_discover_posts.width),height=COALESCE(EXCLUDED.height,hof_discover_posts.height),
        published_at=COALESCE(hof_discover_posts.published_at,EXCLUDED.published_at),
        likes=COALESCE(EXCLUDED.likes,hof_discover_posts.likes),comments=COALESCE(EXCLUDED.comments,hof_discover_posts.comments),
        shares=COALESCE(EXCLUDED.shares,hof_discover_posts.shares),saves=COALESCE(EXCLUDED.saves,hof_discover_posts.saves),
        plays=COALESCE(EXCLUDED.plays,hof_discover_posts.plays),reposts=COALESCE(EXCLUDED.reposts,hof_discover_posts.reposts),
        source_payload=EXCLUDED.source_payload,updated_at=now()
      WHERE hof_discover_posts.creator_social_account_id IS NULL
         OR hof_discover_posts.creator_social_account_id=EXCLUDED.creator_social_account_id
      RETURNING id,(xmax=0) AS inserted`, [
        sourcePostId, sourceUrl, account.id, account.displayName || first(video, ["author_nickname"]) || account.username,
        account.username, caption, hashtags, coverUrl, thumbnailMediaId, duration, width, height, publishedAt,
        metrics.likes, metrics.comments, metrics.shares, metrics.saves, metrics.plays, metrics.reposts, JSON.stringify(video)
      ]);

    if (!result.length) {
      skip("conflict");
      continue;
    }
    if (result[0].inserted) inserted++; else updated++;
    if (hasAnyMetric(metrics)) {
      await query.query(`INSERT INTO hof_post_metric_snapshots(post_id,likes,comments,shares,saves,plays,reposts)
        VALUES($1,$2,$3,$4,$5,$6,$7)`, [result[0].id, metrics.likes, metrics.comments, metrics.shares, metrics.saves, metrics.plays, metrics.reposts]);
      snapshots++;
    }
  }
  // Videos arrived but none could be stored: fail loudly with the reasons instead of recording a silent success
  // (a "success" with nothing stored would also re-queue the account on every cron run).
  if (videos.length > 0 && inserted + updated === 0) {
    throw new Error(`Received ${videos.length} videos but stored none; skipped: ${JSON.stringify(reasons)}`.slice(0, 300));
  }
  return { inserted, updated, skipped, snapshots, received: videos.length, reasons };
}

async function batchProfiles(env: Env, accounts: SocialAccount[]): Promise<Map<string, ReturnType<typeof normalizeTikTok>>> {
  const result = new Map<string, ReturnType<typeof normalizeTikTok>>();
  if (!env.TIKTOK_BATCH_PROFILE_PATH || !env.TIKTOK_SCRAPER_BASE_URL || accounts.length === 0) return result;
  try {
    const base = new URL(env.TIKTOK_SCRAPER_BASE_URL);
    if (base.protocol !== "https:") return result;
    const url = new URL(env.TIKTOK_BATCH_PROFILE_PATH, `${base.toString().replace(/\/+$/, "")}/`);
    const headers = new Headers({ Accept: "application/json", "Content-Type": "application/json" });
      const response = await scraperFetch(env, url, {
      method: "POST", headers, body: JSON.stringify({ handles: accounts.map(account => account.username) }),
      signal: AbortSignal.timeout(20_000), redirect: "manual"
    });
    if (!response.ok) return result;
    const payload = await response.json() as any;
    const list = Array.isArray(payload) ? payload : Array.isArray(payload?.data) ? payload.data :
      Array.isArray(payload?.profiles) ? payload.profiles : Array.isArray(payload?.users) ? payload.users : [];
    for (const item of list) {
      const handle = normalizedHandle(first(item, ["handle", "username", "unique_id"]));
      if (handle) result.set(handle, normalizeTikTok(item, handle));
    }
  } catch {
    // Fall back to the known single-profile endpoint for each account.
  }
  return result;
}

export async function refreshProfile(env: Env, account: SocialAccount, q: ReturnType<typeof db>, batch?: Map<string, ReturnType<typeof normalizeTikTok>>) {
  const metadata = batch?.get(normalizedHandle(account.username)) || await discoverTikTok(env, account.username);
  if (metadata.providerStatus !== "ok" && metadata.providerStatus !== "partial") {
    throw new Error(`TikTok profile status: ${metadata.providerStatus}`);
  }
  const requestedHandle = normalizedHandle(account.username);
  if (normalizedHandle(metadata.username) !== requestedHandle) {
    throw new Error("TikTok profile response handle did not match the requested account");
  }
  if (account.platformUserId && metadata.platformUserId && account.platformUserId !== metadata.platformUserId) {
    throw new Error("TikTok profile identity changed; manual review required");
  }

  await q.query(`UPDATE hof_social_accounts SET
      platform_user_id=COALESCE(platform_user_id,$2),platform_secondary_id=COALESCE($3,platform_secondary_id),
      username=$4,profile_url=$5,display_name=COALESCE($6,display_name),bio=COALESCE($7,bio),
      avatar_url_temporary=COALESCE($8,avatar_url_temporary),is_private=COALESCE($9,is_private),
      platform_verified=COALESCE($10,platform_verified),followers=COALESCE($11,followers),
      following=COALESCE($12,following),video_count=COALESCE($13,video_count),total_likes=COALESCE($14,total_likes),
      metrics_availability=$15::jsonb,last_synced_at=now(),provider_status=$16,provider_message=$17,updated_at=now()
    WHERE id=$1`, [
      account.id, metadata.platformUserId, metadata.platformSecondaryId, metadata.username, metadata.profileUrl,
      metadata.displayName, metadata.bio, metadata.avatarUrl, metadata.isPrivate, metadata.platformVerified,
      metadata.metrics.followers, metadata.metrics.following, metadata.metrics.videos, metadata.metrics.likes,
      JSON.stringify(metadata.metricsAvailability), metadata.providerStatus, metadata.providerMessage
    ]);

  if (Object.values(metadata.metrics).some(value => value !== null)) {
    await q.query(`INSERT INTO hof_social_metric_snapshots(social_account_id,followers,following,videos,likes,availability)
      VALUES($1,$2,$3,$4,$5,$6::jsonb)`, [account.id, metadata.metrics.followers, metadata.metrics.following,
      metadata.metrics.videos, metadata.metrics.likes, JSON.stringify(metadata.metricsAvailability)]);
  }
  return metadata;
}

/** Bounded scheduled work: refresh a small profile slice, enqueue eligible
 * creators, and process no more than one posts pull per invocation. */
/** Claim and run up to `maxJobs` queued post pulls. First-time pulls (new or empty creators) go first. */
export async function processQueuedJobs(env: Env, maxJobs = 3): Promise<unknown[]> {
  const q = db(env);
  const results: unknown[] = [];
  for (let n = 0; n < maxJobs; n++) {
    // Atomic claim: the UPDATE and row lock happen in one database statement.
    const picked = await q.query<{ id: string; socialAccountId: string }>(`WITH next_job AS (
        SELECT id FROM hof_sync_jobs
        WHERE platform='tiktok' AND status='queued'
        ORDER BY attempts ASC, (requested_by IN ('creator-linked','missing-videos')) DESC, created_at, id FOR UPDATE SKIP LOCKED LIMIT 1
      )
      UPDATE hof_sync_jobs j SET status='running',attempts=attempts+1,started_at=now(),finished_at=NULL
      FROM next_job WHERE j.id=next_job.id
      RETURNING j.id,j.social_account_id AS "socialAccountId"`);
    if (!picked.length) break;

    const job = picked[0];
    let failedThisRound = false;
    let failureSummary = "";
    let postsResult: unknown = "none";
    try {
      const rows = await q.query<SocialAccount>(`SELECT id,username,platform_user_id AS "platformUserId",
          display_name AS "displayName",video_count AS "oldVideoCount",NULL::timestamptz AS "lastPostSyncAt"
        FROM hof_social_accounts WHERE id=$1 AND platform='tiktok'`, [job.socialAccountId]);
      if (!rows.length) throw new Error("Social account no longer exists");
      postsResult = await pullPosts(env, rows[0]);
      await q.query("UPDATE hof_sync_jobs SET status='succeeded',finished_at=now(),error_summary=NULL WHERE id=$1", [job.id]);
    } catch (error) {
      failedThisRound = true;
      const summary = error instanceof Error ? error.message : "TikTok collection failed";
      failureSummary = summary;
      await q.query(`UPDATE hof_sync_jobs SET status=CASE WHEN attempts<3 THEN 'queued' ELSE 'failed' END,
        finished_at=now(),error_summary=$2 WHERE id=$1`, [job.id, summary.slice(0, 300)]);
    }
    results.push(postsResult);
    // One unreadable account must not block healthy ones: keep going unless TikTok/the scraper is rate limiting us.
    if (failedThisRound && /429|rate.?limit|too many/i.test(failureSummary)) break;
  }
  return results;
}

export async function runScheduledCollection(env: Env) {
  if (env.TIKTOK_SYNC_ENABLED !== "true") return { disabled: true };
  const q = db(env);

  // Recover jobs left running by a terminated Worker. The posts fetch is bounded;
  // the 20-minute lease leaves ample room for per-post thumbnail caching.
  await q.query(`UPDATE hof_sync_jobs SET
      status=CASE WHEN attempts>=3 THEN 'failed' ELSE 'queued' END,
      finished_at=now(),error_summary=COALESCE(error_summary,'Recovered abandoned collection job')
    WHERE platform='tiktok' AND status='running' AND started_at < now()-interval '20 minutes'`);

  const batchSize = Math.min(30, Math.max(1, Number(env.TIKTOK_SYNC_BATCH_SIZE || 10) || 10));
  const accounts = await q.query<SocialAccount>(`SELECT s.id,s.username,s.platform_user_id AS "platformUserId",
      s.display_name AS "displayName",s.video_count AS "oldVideoCount",
      (SELECT max(finished_at) FROM hof_sync_jobs j WHERE j.social_account_id=s.id AND j.status='succeeded') AS "lastPostSyncAt",
      (SELECT count(*) FROM hof_discover_posts d WHERE d.source='tiktok' AND d.creator_social_account_id=s.id) AS "storedPosts"
    FROM hof_social_accounts s JOIN hof_profiles p ON p.id=s.profile_id
    WHERE s.platform='tiktok' AND p.status='active' AND p.visibility='public'
      AND COALESCE(s.is_private,false)=false
    ORDER BY s.last_synced_at NULLS FIRST LIMIT $1`, [batchSize]);

  let checked = 0;
  let queued = 0;
  let metadataErrors = 0;
  const batch = await batchProfiles(env, accounts);
  for (const account of accounts) {
    try {
      const metadata = await refreshProfile(env, account, q, batch);
      const oldCount = account.oldVideoCount === null ? null : Number(account.oldVideoCount);
      const newCount = metadata.metrics.videos;
      const lastPostSync = account.lastPostSyncAt ? new Date(account.lastPostSyncAt).getTime() : 0;
      const reconciliationDue = !lastPostSync || Date.now() - lastPostSync > 24 * 60 * 60 * 1000;
      const countIncreased = oldCount === null || (newCount !== null && newCount > oldCount);
      // Initial/backfill rule: the profile reports videos but we hold none for this creator.
      const reportedVideos = newCount ?? oldCount;
      const missingVideos = reportedVideos !== null && reportedVideos > 0 && Number(account.storedPosts ?? 0) === 0;
      if (metadata.isPrivate !== true && (countIncreased || reconciliationDue || missingVideos)) {
        const reason = missingVideos ? "missing-videos" : "video-count-increased";
        // No new job while one is queued/running, and after 3 failed attempts pause 6h so a dead account is not retried every cron.
        const jobs = await q.query<{ id: string }>(`INSERT INTO hof_sync_jobs(platform,social_account_id,status,requested_by)
          SELECT 'tiktok',$1,'queued',$2
          WHERE NOT EXISTS(SELECT 1 FROM hof_sync_jobs
            WHERE platform='tiktok' AND social_account_id=$1 AND status IN ('queued','running'))
            AND NOT EXISTS(SELECT 1 FROM hof_sync_jobs
            WHERE platform='tiktok' AND social_account_id=$1 AND status='failed' AND finished_at > now()-interval '6 hours')
          RETURNING id`, [account.id, reason]);
        if (jobs.length) queued++;
      }
      checked++;
    } catch {
      metadataErrors++;
    }
  }

  const postsResults = await processQueuedJobs(env, 3);
  const allPosts: unknown = postsResults.length ? postsResults : "none";
  let creators: unknown = null;
  try { creators = await refreshDueCreators(env, 5); } catch { creators = "error"; }
  return { metadataChecked: checked, metadataErrors, queued, slowPostPull: allPosts, creators };
}
