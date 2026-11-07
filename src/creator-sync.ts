import type { Env } from "./types";
import { db } from "./db";
import { discoverTikTok } from "./tiktok";

/** Fetch a creator from the scraper and store it. Throws on failure after recording provider_status. */
export async function refreshCreator(env: Env, id: string, username: string) {
  try {
    const profile = await discoverTikTok(env, username);
    if (profile.username.toLowerCase() !== username.toLowerCase()) throw new Error("IDENTITY_MISMATCH: the scraper returned a different username");
    const rows = await db(env).query(`UPDATE hof_tiktok_creators SET platform_user_id=COALESCE($2,platform_user_id),sec_uid=COALESCE($3,sec_uid),display_name=COALESCE($4,display_name),bio=COALESCE($5,bio),profile_url=$6,avatar_url=COALESCE($7,avatar_url),is_private=COALESCE($8,is_private),platform_verified=COALESCE($9,platform_verified),followers=COALESCE($10,followers),following=COALESCE($11,following),video_count=COALESCE($12,video_count),total_likes=COALESCE($13,total_likes),provider_status=$14,provider_message=$15,last_synced_at=now(),updated_at=now() WHERE id=$1 RETURNING id,username,display_name AS "displayName",profile_url AS "profileUrl",platform_user_id AS "platformUserId",avatar_url AS "avatarUrl",followers,following,video_count AS "videoCount",total_likes AS "totalLikes",provider_status AS "providerStatus",last_synced_at AS "lastSyncedAt"`, [id,profile.platformUserId,profile.platformSecondaryId,profile.displayName,profile.bio,profile.profileUrl,profile.avatarUrl,profile.isPrivate,profile.platformVerified,profile.metrics.followers,profile.metrics.following,profile.metrics.videos,profile.metrics.likes,profile.providerStatus,profile.providerMessage]);
    await db(env).query(`INSERT INTO hof_tiktok_creator_metric_snapshots(creator_id,followers,following,videos,likes,availability) VALUES($1,$2,$3,$4,$5,$6::jsonb)`, [id,profile.metrics.followers,profile.metrics.following,profile.metrics.videos,profile.metrics.likes,JSON.stringify(profile.metricsAvailability)]);
    return rows[0];
  } catch (e) {
    const message = e instanceof Error ? e.message : "Provider request failed";
    const state = /rate limited/i.test(message) ? "rate_limited" : /not found/i.test(message) ? "not_found" : "error";
    await db(env).query("UPDATE hof_tiktok_creators SET provider_status=$2,provider_message=$3,updated_at=now() WHERE id=$1", [id, state, message.slice(0, 300)]).catch(() => []);
    throw e;
  }
}

/** Cron helper: refresh never-synced or stale (>6h) active creators, a few per run. */
export async function refreshDueCreators(env: Env, limit = 5) {
  const due = await db(env).query<{ id: string; username: string }>(`SELECT id,username FROM hof_tiktok_creators
    WHERE status='active' AND (last_synced_at IS NULL OR last_synced_at < now()-interval '6 hours')
      AND COALESCE(provider_status,'') <> 'not_found'
    ORDER BY last_synced_at NULLS FIRST LIMIT $1`, [limit]);
  let ok = 0, failed = 0;
  for (const c of due) { try { await refreshCreator(env, c.id, c.username); ok++; } catch { failed++; } }
  return { due: due.length, ok, failed };
}
