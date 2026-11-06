import type { Env } from "./types";
import { db } from "./db";
import { discoverTikTok, normalizeTikTok } from "./tiktok";
import { b2Configured, uploadPrivateB2Object } from "./b2";

const n = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const x = Number(v); return Number.isSafeInteger(x) && x >= 0 ? x : null;
};
const first = (o: any, keys: string[]) => { for (const k of keys) if (o?.[k] !== undefined && o[k] !== null) return o[k]; return null; };

async function cacheCover(env: Env, url: string, videoId: string): Promise<string|null> {
  if(!b2Configured(env))return null;
  try{
    const parsed=new URL(url);
    if(parsed.protocol!=="https:"||!/(^|\.)tiktokcdn[^.]*\./i.test(parsed.hostname))return null;
    const r=await fetch(url,{signal:AbortSignal.timeout(10000)});
    if(!r.ok)return null;
    const type=(r.headers.get("content-type")||"").split(";")[0];
    const blob=await r.blob();
    if(!type.startsWith("image/")||blob.size===0||blob.size>5*1024*1024)return null;
    const ext=type.split("/")[1].replace("jpeg","jpg").replace(/[^a-z0-9]/gi,"")||"img";
    const key=`tiktok/thumbnails/${videoId}.${ext}`;
    const file=new File([blob],`${videoId}.${ext}`,{type});
    const stored=await uploadPrivateB2Object(env,key,file);
    const rows=await db(env).query<any>(`INSERT INTO hof_media_assets(object_key,b2_file_id,mime_type,file_size,checksum_sha1,status,visibility)
      VALUES($1,$2,$3,$4,$5,'ready','public') ON CONFLICT(object_key) DO UPDATE SET b2_file_id=EXCLUDED.b2_file_id,
      mime_type=EXCLUDED.mime_type,file_size=EXCLUDED.file_size,checksum_sha1=EXCLUDED.checksum_sha1,status='ready',visibility='public'
      RETURNING id`,[key,stored.fileId,stored.mimeType,stored.size,stored.sha1]);
    return rows[0].id;
  }catch{return null;}
}

async function pullPosts(env: Env, username: string, socialAccountId: string) {
  if (!env.TIKTOK_SCRAPER_BASE_URL || !env.TIKTOK_POSTS_PATH) throw new Error("TIKTOK_POSTS_PATH is not configured");
  const url = new URL(env.TIKTOK_POSTS_PATH, env.TIKTOK_SCRAPER_BASE_URL);
  url.searchParams.set("handle", username);
  const headers = new Headers({ Accept: "application/json" });
  if (env.TIKTOK_SCRAPER_API_KEY) headers.set("Authorization", `Bearer ${env.TIKTOK_SCRAPER_API_KEY}`);
  const response = await fetch(url,{headers,signal:AbortSignal.timeout(25000)});
  if (!response.ok) throw new Error(`Posts provider returned ${response.status}`);
  const raw=await response.json() as any;
  const root=raw?.data && typeof raw.data==="object" ? raw.data : raw;
  const videos=Array.isArray(root?.videos)?root.videos:Array.isArray(raw?.videos)?raw.videos:[];
  const q=db(env);
  let inserted=0,updated=0;
  for(const v of videos){
    const id=String(first(v,["video_id","id"])||"");
    const sourceUrl=String(first(v,["source_url","url"])||"");
    if(!id||!sourceUrl||String(v.status||"ok").toLowerCase()!=="ok"||String(v.is_ad).toLowerCase()==="true")continue;
    const tombstone=await q.query("SELECT 1 FROM hof_deleted_source_posts WHERE source='tiktok' AND source_post_id=$1",[id]);
    if(tombstone.length)continue;
    const create=Number(first(v,["create_time","createTime"]));
    const published=Number.isFinite(create)&&create>0?new Date(create*1000).toISOString():null;
    const likes=n(v.likes),comments=n(v.comments),shares=n(v.shares),saves=n(v.saves),plays=n(v.plays),reposts=n(v.reposts);
    const hashtags=String(v.hashtags||"").split(",").map((x:string)=>x.trim().replace(/^#/,"")).filter(Boolean);
    const coverUrl=String(first(v,["cover_url"])||"");
    const prior=await q.query<any>("SELECT thumbnail_media_id AS id FROM hof_discover_posts WHERE source='tiktok' AND source_post_id=$1",[id]);
    const thumbnailMediaId=prior[0]?.id || (coverUrl?await cacheCover(env,coverUrl,id):null);
    const result=await q.query<any>(`INSERT INTO hof_discover_posts(source,source_post_id,source_url,creator_social_account_id,
      creator_name,creator_handle,caption,hashtags,media_type,external_thumbnail_url,thumbnail_media_id,duration_seconds,width,height,published_at,
      likes,comments,shares,saves,plays,reposts,source_payload,status,visibility)
      VALUES('tiktok',$1,$2,$3,$4,$5,$6,$7,'video',$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20::jsonb,'approved','public')
      ON CONFLICT(source,source_post_id) DO UPDATE SET
      likes=COALESCE(EXCLUDED.likes,hof_discover_posts.likes),comments=COALESCE(EXCLUDED.comments,hof_discover_posts.comments),shares=COALESCE(EXCLUDED.shares,hof_discover_posts.shares),saves=COALESCE(EXCLUDED.saves,hof_discover_posts.saves),
      plays=COALESCE(EXCLUDED.plays,hof_discover_posts.plays),reposts=COALESCE(EXCLUDED.reposts,hof_discover_posts.reposts),
      thumbnail_media_id=COALESCE(EXCLUDED.thumbnail_media_id,hof_discover_posts.thumbnail_media_id),
      source_payload=EXCLUDED.source_payload,updated_at=now()
      RETURNING id,(xmax=0) AS inserted`,
      [id,sourceUrl,socialAccountId,first(v,["author_nickname","author_handle"]),first(v,["author_handle"])||username,
       v.caption||null,hashtags,coverUrl,thumbnailMediaId,n(v.duration_seconds),n(v.width),n(v.height),published,
       likes,comments,shares,saves,plays,reposts,JSON.stringify(v)]);
    if(result.length){
      if(result[0].inserted)inserted++;else updated++;
      await q.query(`INSERT INTO hof_post_metric_snapshots(post_id,likes,comments,shares,saves,plays,reposts)
        VALUES($1,$2,$3,$4,$5,$6,$7)`,[result[0].id,likes,comments,shares,saves,plays,reposts]);
    }
  }
  return {inserted,updated,received:videos.length};
}

/** Scheduled work is deliberately bounded: refresh metadata for a small slice,
 * enqueue changed accounts, then process at most one slow posts pull per tick. */
export async function runScheduledCollection(env: Env) {
  const q=db(env);
  const accounts=await q.query<any>(`SELECT s.id,s.username,s.video_count AS "oldVideoCount"
    ,(SELECT max(finished_at) FROM hof_sync_jobs j WHERE j.social_account_id=s.id AND j.status='succeeded') AS "lastPostSyncAt"
    FROM hof_social_accounts s JOIN hof_profiles p ON p.id=s.profile_id
    WHERE s.platform='tiktok' AND p.status='active' AND p.visibility='public'
    ORDER BY s.last_synced_at NULLS FIRST LIMIT $1`,[Math.min(30,Math.max(1,Number(env.TIKTOK_SYNC_BATCH_SIZE||10)))]);
  let checked=0,queued=0,metadataErrors=0;
  const metadata = new Map<string, Awaited<ReturnType<typeof discoverTikTok>>>();
  if(env.TIKTOK_BATCH_PROFILE_PATH && accounts.length){
    try{
      const url=new URL(env.TIKTOK_BATCH_PROFILE_PATH,env.TIKTOK_SCRAPER_BASE_URL);
      const headers=new Headers({"Accept":"application/json","Content-Type":"application/json"});
      if(env.TIKTOK_SCRAPER_API_KEY)headers.set("Authorization",`Bearer ${env.TIKTOK_SCRAPER_API_KEY}`);
      const response=await fetch(url,{method:"POST",headers,body:JSON.stringify({handles:accounts.map(a=>a.username)}),signal:AbortSignal.timeout(20000)});
      if(!response.ok)throw new Error(`Batch profile provider returned ${response.status}`);
      const payload=await response.json() as any;
      const list=Array.isArray(payload)?payload:Array.isArray(payload.data)?payload.data:Array.isArray(payload.profiles)?payload.profiles:Array.isArray(payload.users)?payload.users:[];
      for(const item of list){const handle=String(first(item,["handle","username","unique_id"])||"").replace(/^@/,"").toLowerCase();if(handle)metadata.set(handle,normalizeTikTok(item,handle));}
    }catch{metadataErrors+=accounts.length;}
  }
  for(const a of accounts){
    try{
      const m=metadata.get(a.username.toLowerCase()) || await discoverTikTok(env,a.username);
      const oldCount=a.oldVideoCount===null?null:Number(a.oldVideoCount);
      const newCount=m.metrics.videos;
      await q.query(`UPDATE hof_social_accounts SET username=$2,platform_user_id=COALESCE($3,platform_user_id),
        display_name=COALESCE($4,display_name),bio=COALESCE($5,bio),avatar_url_temporary=COALESCE($6,avatar_url_temporary),
        is_private=COALESCE($7,is_private),platform_verified=COALESCE($8,platform_verified),
        followers=COALESCE($9,followers),following=COALESCE($10,following),video_count=COALESCE($11,video_count),total_likes=COALESCE($12,total_likes),
        metrics_availability=$13::jsonb,last_synced_at=now(),provider_status=$14,provider_message=$15,updated_at=now()
        WHERE id=$1`,
        [a.id,m.username,m.platformUserId,m.displayName,m.bio,m.avatarUrl,m.isPrivate,m.platformVerified,
         m.metrics.followers,m.metrics.following,m.metrics.videos,m.metrics.likes,JSON.stringify(m.metricsAvailability),m.providerStatus,m.providerMessage]);
      await q.query(`INSERT INTO hof_social_metric_snapshots(social_account_id,followers,following,videos,likes,availability)
        VALUES($1,$2,$3,$4,$5,$6::jsonb)`,[a.id,m.metrics.followers,m.metrics.following,m.metrics.videos,m.metrics.likes,JSON.stringify(m.metricsAvailability)]);
      const lastPostSync=a.lastPostSyncAt?new Date(a.lastPostSyncAt).getTime():0;
      const reconciliationDue=!lastPostSync||Date.now()-lastPostSync>24*60*60*1000;
      if(oldCount===null||(newCount!==null&&newCount>oldCount)||reconciliationDue){
        const jobs=await q.query(`INSERT INTO hof_sync_jobs(platform,social_account_id,status,requested_by)
          SELECT 'tiktok',$1,'queued','video-count-increased'
          WHERE NOT EXISTS(SELECT 1 FROM hof_sync_jobs WHERE social_account_id=$1 AND status IN ('queued','running'))
          RETURNING id`,[a.id]);
        if(jobs.length)queued++;
      }
      checked++;
    }catch{metadataErrors++;}
  }
  // Only one slow post endpoint call per scheduled tick. Never block public requests.
  const picked=await q.query<any>(`WITH job AS (
    SELECT id,social_account_id FROM hof_sync_jobs WHERE platform='tiktok' AND status='queued'
    ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1
  ) UPDATE hof_sync_jobs j SET status='running',attempts=attempts+1,started_at=now()
    FROM job WHERE j.id=job.id RETURNING j.id,j.social_account_id AS "socialAccountId"`);
  let postsResult:any=null;
  if(picked.length){
    const job=picked[0];
    try{
      const account=await q.query<any>("SELECT username FROM hof_social_accounts WHERE id=$1",[job.socialAccountId]);
      if(!account.length)throw new Error("Social account no longer exists");
      postsResult=await pullPosts(env,account[0].username,job.socialAccountId);
      await q.query("UPDATE hof_sync_jobs SET status='succeeded',finished_at=now(),error_summary=NULL WHERE id=$1",[job.id]);
    }catch(error){
      await q.query("UPDATE hof_sync_jobs SET status=CASE WHEN attempts<3 THEN 'queued' ELSE 'failed' END,finished_at=now(),error_summary=$2 WHERE id=$1",[job.id,String(error).slice(0,300)]);
    }
  }
  return {metadataChecked:checked,metadataErrors,queued,slowPostPull:postsResult||"none"};
}
