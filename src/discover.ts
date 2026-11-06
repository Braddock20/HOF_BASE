import { Hono } from "hono";
import { z } from "zod";
import type { Env, AppVariables } from "./types";
import { db } from "./db";
import { fail, ok, slugify } from "./http";
import { requireAdmin, requirePermission } from "./auth";
import { b2Configured, deletePrivateB2Object, fetchPrivateB2Object, uploadPrivateB2Object } from "./b2";

type E = { Bindings: Env; Variables: AppVariables };
export const discover = new Hono<E>();
const admin = new Hono<E>();
const pageSize = (v: string | undefined) => { const n=Number(v||24); return Number.isFinite(n)?Math.min(48,Math.max(1,Math.floor(n))):24; };
async function visitorHash(value: string | null) {
  if(!value || value.length<16 || value.length>120)return null;
  const digest=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,"0")).join("");
}

discover.get("/feed", async c => {
  const limit = pageSize(c.req.query("limit"));
  const cursor = c.req.query("cursor");
  try {
    const q = db(c.env);
    let sessionId: string, offset = 0;
    if (cursor) {
      const [sid, off] = cursor.split(":");
      if (!/^[0-9a-f-]{36}$/i.test(sid || "") || !/^\d+$/.test(off || "")) return fail(c,400,"INVALID_CURSOR","Feed cursor is invalid.");
      sessionId = sid; offset = Number(off);
      const exists = await q.query("SELECT id FROM hof_discover_feed_sessions WHERE id=$1 AND expires_at>now()",[sessionId]);
      if (!exists.length) return fail(c,410,"FEED_EXPIRED","This feed session expired. Refresh Discover.");
    } else {
      const visitor=await visitorHash(c.req.header("X-HOF-Visitor")||c.req.query("visitor")||null);
      const sessions = await q.query<{id:string}>(`
        WITH eligible AS MATERIALIZED (
          SELECT id,CASE WHEN published_at>=now()-interval '7 days' THEN 0 ELSE 1 END AS recent_group
          FROM hof_discover_posts WHERE status='approved' AND visibility='public' AND deleted_at IS NULL
        ), fresh AS MATERIALIZED (
          SELECT e.* FROM eligible e WHERE $1::text IS NULL OR NOT EXISTS(
            SELECT 1 FROM hof_discover_seen_posts s WHERE s.visitor_hash=$1 AND s.post_id=e.id
          )
        ), chosen AS (
          SELECT * FROM fresh
          UNION ALL
          SELECT * FROM eligible WHERE NOT EXISTS(SELECT 1 FROM fresh)
        )
        INSERT INTO hof_discover_feed_sessions(post_ids)
        SELECT COALESCE(array_agg(id ORDER BY (random()+CASE WHEN recent_group=0 THEN 0.45 ELSE 0 END) DESC),'{}'::uuid[])
        FROM chosen RETURNING id`,[visitor]);
      sessionId = sessions[0].id;
    }
    const rows = await q.query<any>(`
      SELECT f.ord,p.id,p.source,p.source_post_id AS "sourcePostId",p.source_url AS "sourceUrl",
        p.creator_name AS "creatorName",p.creator_handle AS "creatorHandle",p.caption,p.hashtags,
        p.media_type AS "mediaType",p.duration_seconds AS "durationSeconds",p.width,p.height,
        CASE WHEN p.width>0 AND p.height>0 THEN round((p.width::numeric/p.height::numeric),4) ELSE NULL END AS "aspectRatio",
        p.published_at AS "publishedAt",p.likes,p.comments,p.shares,p.saves,p.plays,p.reposts,
        p.external_thumbnail_url AS "externalThumbnailUrl",
        p.thumbnail_media_id AS "thumbnailMediaId",p.media_asset_id AS "mediaAssetId"
      FROM unnest((SELECT post_ids FROM hof_discover_feed_sessions WHERE id=$1)) WITH ORDINALITY f(id,ord)
      JOIN hof_discover_posts p ON p.id=f.id
      WHERE f.ord>$2 AND p.status='approved' AND p.visibility='public' AND p.deleted_at IS NULL
      ORDER BY f.ord LIMIT $3`,[sessionId,offset,limit+1]);
    const hasMore = rows.length > limit;
    const items = rows.slice(0,limit).map((p:any) => ({
      id:p.id, source:p.source, source_post_id:p.sourcePostId, source_url:p.sourceUrl,
      creator:{name:p.creatorName,handle:p.creatorHandle}, caption:p.caption, hashtags:p.hashtags,
      type:p.mediaType, duration_seconds:p.durationSeconds, width:p.width, height:p.height,
      aspect_ratio:p.aspectRatio, published_at:p.publishedAt,
      engagement:{likes:p.likes,comments:p.comments,shares:p.shares,saves:p.saves,plays:p.plays,reposts:p.reposts},
      thumbnail_url:p.thumbnailMediaId ? `${new URL(c.req.url).origin}/api/media/${p.thumbnailMediaId}` :
        (p.mediaType==="image" && p.mediaAssetId ? `${new URL(c.req.url).origin}/api/media/${p.mediaAssetId}` : null),
      media_url:p.mediaAssetId ? `${new URL(c.req.url).origin}/api/media/${p.mediaAssetId}` : null,
      embed_url:p.source==="tiktok" && p.sourcePostId ? `https://www.tiktok.com/player/v1/${encodeURIComponent(p.sourcePostId)}` : null,
      playable:p.mediaType==="video"
    }));
    return ok(c,{feed_id:sessionId,generated_at:new Date().toISOString(),page_size:limit,has_more:hasMore,
      next_cursor:hasMore?`${sessionId}:${Number(rows[limit-1].ord)}`:null,layout:"masonry",posts:items});
  } catch { return fail(c,503,"DATABASE_UNAVAILABLE","Discover feed is temporarily unavailable."); }
});

discover.get("/latest", async c => {
  try {
    const rows = await db(c.env).query<any>(`SELECT id,source,source_post_id AS "sourcePostId",source_url AS "sourceUrl",
      creator_name AS "creatorName",creator_handle AS "creatorHandle",caption,media_type AS "mediaType",
      width,height,thumbnail_media_id AS "thumbnailMediaId",media_asset_id AS "mediaAssetId",published_at AS "publishedAt"
      FROM hof_discover_posts WHERE status='approved' AND visibility='public' AND deleted_at IS NULL
      ORDER BY published_at DESC NULLS LAST,created_at DESC LIMIT $1`,[pageSize(c.req.query("limit"))]);
    const origin=new URL(c.req.url).origin;
    return ok(c,rows.map((r:any)=>({...r,thumbnailUrl:r.thumbnailMediaId?`${origin}/api/media/${r.thumbnailMediaId}`:(r.mediaType==="image"&&r.mediaAssetId?`${origin}/api/media/${r.mediaAssetId}`:null)})));
  } catch { return fail(c,503,"DATABASE_UNAVAILABLE","Latest posts unavailable."); }
});

discover.get("/posts/:id", async c => {
  try {
    const rows=await db(c.env).query(`SELECT id,source,source_post_id AS "sourcePostId",source_url AS "sourceUrl",
      creator_name AS "creatorName",creator_handle AS "creatorHandle",caption,hashtags,media_type AS "mediaType",
      duration_seconds AS "durationSeconds",width,height,thumbnail_media_id AS "thumbnailMediaId",media_asset_id AS "mediaAssetId",
      published_at AS "publishedAt",likes,comments,shares,saves,plays
      FROM hof_discover_posts WHERE id=$1 AND status='approved' AND visibility='public' AND deleted_at IS NULL`,[c.req.param("id")]);
    if(!rows.length)return fail(c,404,"NOT_FOUND","Post not found.");
    const r:any=rows[0],origin=new URL(c.req.url).origin;
    return ok(c,{...r,thumbnailUrl:r.thumbnailMediaId?`${origin}/api/media/${r.thumbnailMediaId}`:(r.mediaType==="image"&&r.mediaAssetId?`${origin}/api/media/${r.mediaAssetId}`:null),mediaUrl:r.mediaAssetId?`${origin}/api/media/${r.mediaAssetId}`:null});
  }catch{return fail(c,503,"DATABASE_UNAVAILABLE","Post unavailable.");}
});

discover.get("/categories", async c => {
  try {
    return ok(c,await db(c.env).query(`SELECT id,name,slug,description
      FROM hof_categories WHERE is_active ORDER BY display_order,name`));
  }catch{return fail(c,503,"DATABASE_UNAVAILABLE","Discover categories unavailable.");}
});
discover.get("/trending", async c => {
  try {
    const rows=await db(c.env).query<any>(`WITH latest AS (
      SELECT DISTINCT ON(post_id) post_id,captured_at,likes,comments,shares,saves,plays
      FROM hof_post_metric_snapshots ORDER BY post_id,captured_at DESC
    ), baseline AS (
      SELECT DISTINCT ON(post_id) post_id,captured_at,likes,comments,shares,saves,plays
      FROM hof_post_metric_snapshots WHERE captured_at<=now()-interval '24 hours'
      ORDER BY post_id,captured_at DESC
    )
    SELECT p.id,p.creator_name AS "creatorName",p.creator_handle AS "creatorHandle",
      p.caption,p.source_url AS "sourceUrl",p.thumbnail_media_id AS "thumbnailMediaId",p.media_asset_id AS "mediaAssetId",
      p.media_type AS "mediaType",p.published_at AS "publishedAt",
      GREATEST(0,COALESCE(l.likes,0)-COALESCE(b.likes,l.likes,0)) AS "likesGained",
      GREATEST(0,COALESCE(l.comments,0)-COALESCE(b.comments,l.comments,0)) AS "commentsGained",
      GREATEST(0,COALESCE(l.shares,0)-COALESCE(b.shares,l.shares,0)) AS "sharesGained",
      GREATEST(0,COALESCE(l.plays,0)-COALESCE(b.plays,l.plays,0)) AS "playsGained"
    FROM hof_discover_posts p JOIN latest l ON l.post_id=p.id JOIN baseline b ON b.post_id=p.id
    WHERE p.status='approved' AND p.visibility='public' AND p.deleted_at IS NULL
      AND l.captured_at>now()-interval '7 days'
    ORDER BY ("likesGained"+("commentsGained"*3)+("sharesGained"*4)+("playsGained"/10)) DESC
    LIMIT $1`,[pageSize(c.req.query("limit"))]);
    const origin=new URL(c.req.url).origin;
    return ok(c,rows.map((r:any)=>({...r,thumbnailUrl:r.thumbnailMediaId?`${origin}/api/media/${r.thumbnailMediaId}`:(r.mediaType==="image"&&r.mediaAssetId?`${origin}/api/media/${r.mediaAssetId}`:null)})));
  }catch{return fail(c,503,"DATABASE_UNAVAILABLE","Discover trending unavailable.");}
});

// Anyone may submit a post suggestion; it remains private until admin approval.
discover.post("/submissions", async c => {
  const body=await c.req.json().catch(()=>null);
  const p=z.object({source:z.enum(["tiktok","external"]).default("tiktok"),sourceUrl:z.string().url().max(2000),
    sourcePostId:z.string().max(100).optional(),creatorHandle:z.string().max(100).optional(),
    caption:z.string().max(3000).optional(),mediaType:z.enum(["video","image","carousel"]),
    thumbnailUrl:z.string().url().max(2000).optional(),width:z.number().int().positive().max(10000).optional(),
    height:z.number().int().positive().max(10000).optional(),durationSeconds:z.number().positive().max(3600).optional(),
    reason:z.string().min(5).max(1000),submitterRef:z.string().max(120).optional()}).safeParse(body);
  if(!p.success)return fail(c,400,"VALIDATION_ERROR","Submission details are invalid.");
  try{
    const r=await db(c.env).query(`INSERT INTO hof_discover_submissions(source,source_url,source_post_id,creator_handle,caption,media_type,thumbnail_url,width,height,duration_seconds,reason,submitter_ref)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id,status,created_at AS "createdAt"`,
      [p.data.source,p.data.sourceUrl,p.data.sourcePostId||null,p.data.creatorHandle||null,p.data.caption||null,p.data.mediaType,p.data.thumbnailUrl||null,p.data.width||null,p.data.height||null,p.data.durationSeconds||null,p.data.reason,p.data.submitterRef||null]);
    return ok(c,r[0],201);
  }catch{return fail(c,503,"DATABASE_UNAVAILABLE","Submission could not be saved.");}
});

discover.post("/reports", async c => {
  const body=await c.req.json().catch(()=>null);
  const p=z.object({postId:z.string().uuid(),reportType:z.enum(["copyright","inappropriate","spam","misinformation","other"]),description:z.string().max(1500).optional(),reporterRef:z.string().max(120).optional()}).safeParse(body);
  if(!p.success)return fail(c,400,"VALIDATION_ERROR","Report details are invalid.");
  try{
    const rows=await db(c.env).query(`INSERT INTO hof_discover_reports(post_id,report_type,description,reporter_ref)
      SELECT $1,$2,$3,$4 WHERE EXISTS(SELECT 1 FROM hof_discover_posts WHERE id=$1 AND status='approved' AND deleted_at IS NULL)
      RETURNING id,status,created_at AS "createdAt"`,[p.data.postId,p.data.reportType,p.data.description||null,p.data.reporterRef||null]);
    if(!rows.length)return fail(c,404,"NOT_FOUND","Post not found.");
    return ok(c,rows[0],201);
  }catch{return fail(c,503,"DATABASE_UNAVAILABLE","Report could not be submitted.");}
});

// Lightweight creator request; users cannot choose HOF categories or verification.
discover.post("/creator-requests", async c => {
  const body=await c.req.json().catch(()=>null);
  const p=z.object({username:z.string().min(2).max(100).regex(/^@?[A-Za-z0-9._]+$/),
    platform:z.enum(["tiktok","instagram","youtube"]).default("tiktok"),displayName:z.string().max(120).optional(),
    profileUrl:z.string().url().max(2000).optional(),reason:z.string().min(5).max(1000),submitterRef:z.string().max(120).optional()}).safeParse(body);
  if(!p.success)return fail(c,400,"VALIDATION_ERROR","Creator request details are invalid.");
  const username=p.data.username.replace(/^@/,"");
  const defaultUrl=p.data.platform==="instagram"?`https://www.instagram.com/${encodeURIComponent(username)}/`:
    p.data.platform==="youtube"?`https://www.youtube.com/@${encodeURIComponent(username)}`:
    `https://www.tiktok.com/@${encodeURIComponent(username)}`;
  const url=p.data.profileUrl||defaultUrl;
  try{
    const rows=await db(c.env).query(`INSERT INTO hof_creator_requests(display_name,platform,username,profile_url,reason,submitter_ref)
      VALUES($1,$2,$3,$4,$5,$6) RETURNING id,status,created_at AS "createdAt"`,
      [p.data.displayName||null,p.data.platform,username,url,p.data.reason,p.data.submitterRef||null]);
    return ok(c,rows[0],201);
  }catch{return fail(c,503,"DATABASE_UNAVAILABLE","Creator request could not be saved.");}
});

// Client calls this when tiles actually enter the viewport. The visitor key is
// pseudonymous and hashed before storage; the frontend also keeps its offline seen list.
discover.post("/seen", async c => {
  const body=await c.req.json().catch(()=>null);
  const p=z.object({visitorId:z.string().min(16).max(120),postIds:z.array(z.string().uuid()).min(1).max(100)}).safeParse(body);
  if(!p.success)return fail(c,400,"VALIDATION_ERROR","A visitor ID and up to 100 post IDs are required.");
  try{
    const hash=await visitorHash(p.data.visitorId);
    if(!hash)return fail(c,400,"VALIDATION_ERROR","Visitor ID is invalid.");
    const rows=await db(c.env).query(`INSERT INTO hof_discover_seen_posts(visitor_hash,post_id)
      SELECT $1,x::uuid FROM unnest($2::text[]) x
      ON CONFLICT(visitor_hash,post_id) DO UPDATE SET last_seen_at=now() RETURNING post_id`,[hash,p.data.postIds]);
    return ok(c,{recorded:rows.length});
  }catch{return fail(c,503,"DATABASE_UNAVAILABLE","Seen history could not be saved.");}
});

// Uploads go into the private B2 bucket. Only an admin-approved submission is made public.
discover.post("/uploads", async c => {
  if(!b2Configured(c.env))return fail(c,503,"MEDIA_STORAGE_NOT_CONFIGURED","Private media storage is not configured.");
  const form=await c.req.formData().catch(()=>null);
  const file=form?.get("file");
  const thumbnail=form?.get("thumbnail");
  const reason=String(form?.get("reason")||"");
  const submitterRef=String(form?.get("submitterRef")||"").slice(0,120)||null;
  const width=Math.min(10000,Math.max(0,Number(form?.get("width")||0)))||null;
  const height=Math.min(10000,Math.max(0,Number(form?.get("height")||0)))||null;
  if(!(file instanceof File)||!["image/jpeg","image/png","image/webp","image/gif","video/mp4","video/webm"].includes(file.type))
    return fail(c,400,"INVALID_MEDIA","Upload a supported image or MP4/WebM video.");
  if(file.size>8*1024*1024)return fail(c,413,"FILE_TOO_LARGE","This upload endpoint supports files up to 8 MB.");
  if(reason.trim().length<5||reason.length>1000)return fail(c,400,"VALIDATION_ERROR","A submission reason is required.");
  const ext=file.type.split("/")[1].replace("jpeg","jpg");
  const key=`uploads/pending/${crypto.randomUUID()}.${ext}`;
  let phase="b2_upload";
  try{
    const stored=await uploadPrivateB2Object(c.env,key,file);
    phase="media_record_insert";
    const rows=await db(c.env).query(`INSERT INTO hof_media_assets(object_key,b2_file_id,mime_type,file_size,width,height,checksum_sha1,status,visibility)
      VALUES($1,$2,$3,$4,$5,$6,$7,'ready','private') RETURNING id`,[key,stored.fileId,stored.mimeType,stored.size,width,height,stored.sha1]);
    const mediaId=rows[0].id;
    let thumbnailId:string|null=null;
    if(thumbnail instanceof File&&thumbnail.type.startsWith("image/")&&thumbnail.size>0&&thumbnail.size<=2*1024*1024){
      const thumbExt=thumbnail.type.split("/")[1].replace("jpeg","jpg").replace(/[^a-z0-9]/gi,"")||"img";
      const thumbKey=`uploads/pending-thumbnails/${crypto.randomUUID()}.${thumbExt}`;
      phase="thumbnail_b2_upload";
      const thumbStored=await uploadPrivateB2Object(c.env,thumbKey,thumbnail);
      phase="thumbnail_record_insert";
      const thumbRows=await db(c.env).query<any>(`INSERT INTO hof_media_assets(object_key,b2_file_id,mime_type,file_size,checksum_sha1,status,visibility)
        VALUES($1,$2,$3,$4,$5,'ready','private') RETURNING id`,[thumbKey,thumbStored.fileId,thumbStored.mimeType,thumbStored.size,thumbStored.sha1]);
      thumbnailId=thumbRows[0].id;
    }
    phase="submission_record_insert";
    const sub=await db(c.env).query(`INSERT INTO hof_discover_submissions(source,media_type,reason,media_asset_id,thumbnail_media_id,submitter_ref,width,height)
      VALUES('hof',$1,$2,$3,$4,$5,$6,$7) RETURNING id,status`,[file.type.startsWith("video/")?"video":"image",reason,mediaId,thumbnailId,submitterRef,width,height]);
    return ok(c,{submissionId:sub[0].id,status:sub[0].status,mediaId},201);
  }catch(error){
    const message=error instanceof Error?error.message:"unknown";
    const b2Status=message.match(/\((\d{3})\)/)?.[1]||null;
    console.error(JSON.stringify({event:"discover_upload_failed",requestId:c.get("requestId"),phase,errorName:error instanceof Error?error.name:"UnknownError",b2Status}));
    return fail(c,503,"UPLOAD_FAILED","Private media upload failed. Please retry.");
  }
});

discover.get("/media-config", c=>ok(c,{storage:"private-b2",delivery:"stable-hof-proxy",uploadMaxBytes:8*1024*1024}));

// Stable URL proxy: the private B2 authorization token never reaches clients.
export const media = new Hono<E>();
media.get("/:id",async c=>{
  try{
    const rows=await db(c.env).query<any>(`SELECT object_key AS "objectKey",mime_type AS "mimeType",file_size AS "fileSize"
      FROM hof_media_assets WHERE id=$1 AND status='ready' AND visibility='public'`,[c.req.param("id")]);
    if(!rows.length)return fail(c,404,"MEDIA_NOT_FOUND","Media not found.");
    const upstream=await fetchPrivateB2Object(c.env,rows[0].objectKey,c.req.header("range"));
    if(!upstream.ok)return fail(c,502,"MEDIA_UNAVAILABLE","Media is temporarily unavailable.");
    const headers=new Headers();
    headers.set("Content-Type",rows[0].mimeType);
    headers.set("Cache-Control","public, max-age=3600, stale-while-revalidate=86400");
    headers.set("X-Content-Type-Options","nosniff");
    for(const k of ["content-length","content-range","accept-ranges"]) { const v=upstream.headers.get(k); if(v)headers.set(k,v); }
    return new Response(upstream.body,{status:upstream.status,headers});
  }catch{return fail(c,503,"MEDIA_STORAGE_UNAVAILABLE","Media storage is temporarily unavailable.");}
});

admin.use("*",requireAdmin);
admin.get("/media/:id",requirePermission("media.manage"),async c=>{
  try{
    const rows=await db(c.env).query<any>(`SELECT object_key AS "objectKey",mime_type AS "mimeType"
      FROM hof_media_assets WHERE id=$1 AND status='ready'`,[c.req.param("id")]);
    if(!rows.length)return fail(c,404,"MEDIA_NOT_FOUND","Media not found.");
    const upstream=await fetchPrivateB2Object(c.env,rows[0].objectKey,c.req.header("range"));
    if(!upstream.ok)return fail(c,502,"MEDIA_UNAVAILABLE","Media is temporarily unavailable.");
    const headers=new Headers({"Content-Type":rows[0].mimeType,"Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff"});
    for(const k of ["content-length","content-range","accept-ranges"]){const v=upstream.headers.get(k);if(v)headers.set(k,v);}
    return new Response(upstream.body,{status:upstream.status,headers});
  }catch{return fail(c,503,"MEDIA_STORAGE_UNAVAILABLE","Media storage is unavailable.");}
});
admin.get("/posts",requirePermission("discover.view"),async c=>{
  try{return ok(c,await db(c.env).query(`SELECT id,source,source_url AS "sourceUrl",creator_name AS "creatorName",creator_handle AS "creatorHandle",
    caption,media_type AS "mediaType",status,visibility,published_at AS "publishedAt",created_at AS "createdAt"
    FROM hof_discover_posts ORDER BY created_at DESC LIMIT $1`,[pageSize(c.req.query("limit"))]));}
  catch{return fail(c,503,"DATABASE_UNAVAILABLE","Discover moderation queue unavailable.");}
});
admin.get("/reports",requirePermission("discover.reports.review"),async c=>{
  try{return ok(c,await db(c.env).query(`SELECT r.*,p.caption,p.source_url AS "sourceUrl" FROM hof_discover_reports r
    JOIN hof_discover_posts p ON p.id=r.post_id ORDER BY r.created_at DESC LIMIT $1`,[pageSize(c.req.query("limit"))]));}
  catch{return fail(c,503,"DATABASE_UNAVAILABLE","Reports unavailable.");}
});
admin.patch("/reports/:id",requirePermission("discover.reports.review"),async c=>{
  const b=await c.req.json().catch(()=>null);
  const p=z.object({status:z.enum(["reviewing","resolved","dismissed"]),resolutionNote:z.string().min(3).max(1000),postAction:z.enum(["none","hide","delete"]).default("none"),confirm:z.boolean().optional()}).safeParse(b);
  if(!p.success)return fail(c,400,"VALIDATION_ERROR","Report review details are invalid.");
  if(p.data.postAction==="delete"&&p.data.confirm!==true)return fail(c,400,"CONFIRMATION_REQUIRED","Set confirm=true to remove the reported post.");
  try{
    const rows=await db(c.env).query(`UPDATE hof_discover_reports SET status=$2,resolution_note=$3,reviewed_by=NULL,reviewed_at=now() WHERE id=$1 RETURNING id,status`,[c.req.param("id"),p.data.status,p.data.resolutionNote]);
    if(!rows.length)return fail(c,404,"NOT_FOUND","Report not found.");
    if(p.data.postAction==="hide")await db(c.env).query("UPDATE hof_discover_posts SET status='hidden',updated_at=now() WHERE id=(SELECT post_id FROM hof_discover_reports WHERE id=$1)",[c.req.param("id")]);
    if(p.data.postAction==="delete"){
      await db(c.env).query("UPDATE hof_discover_posts SET status='deleted',visibility='hidden',deleted_at=now(),updated_at=now() WHERE id=(SELECT post_id FROM hof_discover_reports WHERE id=$1)",[c.req.param("id")]);
    }
    await db(c.env).query(`INSERT INTO hof_audit_logs(actor_subject,action,target_type,target_id,reason,request_id)
      VALUES('admin-api-key','discover.report.review','discover_report',$1,$2,$3)`,[c.req.param("id"),p.data.resolutionNote,c.get("requestId")]);
    return ok(c,rows[0]);
  }catch{return fail(c,503,"DATABASE_UNAVAILABLE","Report review failed.");}
});
admin.get("/submissions",requirePermission("discover.submissions.review"),async c=>{
  try{return ok(c,await db(c.env).query(`SELECT s.*,m.mime_type AS "mimeType",m.file_size AS "fileSize"
    FROM hof_discover_submissions s LEFT JOIN hof_media_assets m ON m.id=s.media_asset_id
    WHERE s.status='pending' ORDER BY s.created_at LIMIT $1`,[pageSize(c.req.query("limit"))]).then((rows:any[])=>rows.map(r=>({...r,previewUrl:r.media_asset_id?`${new URL(c.req.url).origin}/api/admin/discover/media/${r.media_asset_id}`:null,thumbnailPreviewUrl:r.thumbnail_media_id?`${new URL(c.req.url).origin}/api/admin/discover/media/${r.thumbnail_media_id}`:null}))));}
  catch{return fail(c,503,"DATABASE_UNAVAILABLE","Discover submissions unavailable.");}
});
admin.patch("/submissions/:id",requirePermission("discover.submissions.review"),async c=>{
  const b=await c.req.json().catch(()=>null);
  const p=z.object({status:z.enum(["approved","rejected"]),reviewNote:z.string().min(3).max(1000)}).safeParse(b);
  if(!p.success)return fail(c,400,"VALIDATION_ERROR","Submission review details are invalid.");
  try{
    const rows=await db(c.env).query<any>(`UPDATE hof_discover_submissions SET status=$2,review_note=$3,reviewed_at=now()
      WHERE id=$1 AND status='pending' RETURNING *`,[c.req.param("id"),p.data.status,p.data.reviewNote]);
    if(!rows.length)return fail(c,404,"NOT_FOUND","Pending submission not found.");
    if(p.data.status==="approved"){
      const s=rows[0];
      const post=await db(c.env).query(`INSERT INTO hof_discover_posts(source,source_url,source_post_id,creator_handle,caption,media_type,
        external_thumbnail_url,width,height,duration_seconds,media_asset_id,thumbnail_media_id,status,visibility,published_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'approved','public',now())
        ON CONFLICT(source,source_post_id) DO UPDATE SET status='approved',visibility='public',updated_at=now()
        RETURNING id`,
        [s.source,s.source_url,s.source_post_id,s.creator_handle,s.caption,s.media_type,s.thumbnail_url,s.width,s.height,s.duration_seconds,s.media_asset_id,s.thumbnail_media_id]);
      if(s.media_asset_id)await db(c.env).query("UPDATE hof_media_assets SET visibility='public' WHERE id=$1",[s.media_asset_id]);
      if(s.thumbnail_media_id)await db(c.env).query("UPDATE hof_media_assets SET visibility='public' WHERE id=$1",[s.thumbnail_media_id]);
      await db(c.env).query(`INSERT INTO hof_audit_logs(actor_subject,action,target_type,target_id,reason,request_id)
        VALUES('admin-api-key','discover.submission.approve','discover_submission',$1,$2,$3)`,[s.id,p.data.reviewNote,c.get("requestId")]);
      return ok(c,{submissionId:s.id,postId:post[0].id,status:"approved"});
    }
    for(const mediaId of [rows[0].media_asset_id,rows[0].thumbnail_media_id].filter(Boolean)){
      const assets=await db(c.env).query<any>("SELECT object_key AS \"objectKey\",b2_file_id AS \"fileId\" FROM hof_media_assets WHERE id=$1",[mediaId]);
      if(assets.length&&assets[0].fileId){
        try{await deletePrivateB2Object(c.env,assets[0].fileId,assets[0].objectKey);await db(c.env).query("DELETE FROM hof_media_assets WHERE id=$1",[mediaId]);}
        catch{await db(c.env).query("UPDATE hof_media_assets SET status='deleted',visibility='private',deleted_at=now() WHERE id=$1",[mediaId]);}
      }
    }
    await db(c.env).query(`INSERT INTO hof_audit_logs(actor_subject,action,target_type,target_id,reason,request_id)
      VALUES('admin-api-key','discover.submission.reject','discover_submission',$1,$2,$3)`,[rows[0].id,p.data.reviewNote,c.get("requestId")]);
    return ok(c,{submissionId:rows[0].id,status:"rejected"});
  }catch{return fail(c,503,"DATABASE_UNAVAILABLE","Submission review failed.");}
});
admin.get("/creator-requests",requirePermission("creator.requests.review"),async c=>{
  try{return ok(c,await db(c.env).query("SELECT * FROM hof_creator_requests WHERE status='pending' ORDER BY created_at LIMIT $1",[pageSize(c.req.query("limit"))]));}
  catch{return fail(c,503,"DATABASE_UNAVAILABLE","Creator requests unavailable.");}
});
admin.patch("/creator-requests/:id",requirePermission("creator.requests.review"),async c=>{
  const b=await c.req.json().catch(()=>null);
  const p=z.object({status:z.enum(["approved","rejected"]),reviewNote:z.string().min(3).max(1000),
    categoryId:z.string().uuid().optional(),displayName:z.string().min(2).max(120).optional()}).safeParse(b);
  if(!p.success)return fail(c,400,"VALIDATION_ERROR","Creator review details are invalid.");
  if(p.data.status==="approved"&&!p.data.categoryId)return fail(c,400,"CATEGORY_REQUIRED","Admin must choose a category before approval.");
  try{
    const reqs=await db(c.env).query<any>("SELECT * FROM hof_creator_requests WHERE id=$1 AND status='pending'",[c.req.param("id")]);
    if(!reqs.length)return fail(c,404,"NOT_FOUND","Pending creator request not found.");
    const r=reqs[0];
    if(p.data.status==="rejected"){
      await db(c.env).query("UPDATE hof_creator_requests SET status='rejected',review_note=$2,reviewed_at=now() WHERE id=$1",[r.id,p.data.reviewNote]);
      await db(c.env).query(`INSERT INTO hof_audit_logs(actor_subject,action,target_type,target_id,reason,request_id)
        VALUES('admin-api-key','creator_request.reject','creator_request',$1,$2,$3)`,[r.id,p.data.reviewNote,c.get("requestId")]);
      return ok(c,{requestId:r.id,status:"rejected"});
    }
    const name=p.data.displayName||r.display_name||r.username;
    const slug=slugify(name)+"-"+String(r.id).slice(0,6);
    const profiles=await db(c.env).query<any>(`INSERT INTO hof_profiles(display_name,slug,status,visibility)
      VALUES($1,$2,'active','public') RETURNING id,slug`,[name,slug]);
    const profile=profiles[0];
    await db(c.env).query(`INSERT INTO hof_social_accounts(profile_id,platform,username,profile_url,display_name,provider_status)
      VALUES($1,$2,$3,$4,$5,'partial')`,[profile.id,r.platform,r.username,r.profile_url,name]);
    const assigned=await db(c.env).query("INSERT INTO hof_profile_categories(profile_id,category_id) SELECT $1,$2 WHERE EXISTS(SELECT 1 FROM hof_categories WHERE id=$2 AND is_active) RETURNING category_id",[profile.id,p.data.categoryId]);
    if(!assigned.length)throw new Error("Selected category is unavailable");
    await db(c.env).query("UPDATE hof_creator_requests SET status='approved',review_note=$2,reviewed_at=now() WHERE id=$1",[r.id,p.data.reviewNote]);
    await db(c.env).query(`INSERT INTO hof_audit_logs(actor_subject,action,target_type,target_id,reason,request_id,after_state)
      VALUES('admin-api-key','creator_request.approve','creator_request',$1,$2,$3,json_build_object('profileId',$4,'categoryId',$5))`,
      [r.id,p.data.reviewNote,c.get("requestId"),profile.id,p.data.categoryId]);
    return ok(c,{requestId:r.id,profileId:profile.id,slug:profile.slug,status:"approved"},201);
  }catch{return fail(c,409,"CONFLICT","Creator approval failed; check category and duplicate profile/account.");}
});
admin.post("/posts/:id/review",requirePermission("discover.moderate"),async c=>{
  const b=await c.req.json().catch(()=>null);
  const p=z.object({action:z.enum(["approve","reject","hide","restore"]),reason:z.string().min(5).max(1000)}).safeParse(b);
  if(!p.success)return fail(c,400,"VALIDATION_ERROR","Moderation action and reason are required.");
  const status={approve:"approved",reject:"rejected",hide:"hidden",restore:"approved"}[p.data.action];
  try{
    const rows=await db(c.env).query("UPDATE hof_discover_posts SET status=$2,visibility=CASE WHEN $2='approved' THEN 'public' ELSE 'hidden' END,approved_at=CASE WHEN $2='approved' THEN now() ELSE approved_at END,updated_at=now() WHERE id=$1 RETURNING id,status",[c.req.param("id"),status]);
    if(!rows.length)return fail(c,404,"NOT_FOUND","Post not found.");
    await db(c.env).query(`INSERT INTO hof_audit_logs(actor_subject,action,target_type,target_id,reason,request_id)
      VALUES('admin-api-key',$1,'discover_post',$2,$3,$4)`,[`discover.${p.data.action}`,c.req.param("id"),p.data.reason,c.get("requestId")]);
    return ok(c,rows[0]);
  }catch{return fail(c,503,"DATABASE_UNAVAILABLE","Post moderation failed.");}
});
admin.delete("/posts/:id",requirePermission("discover.moderate"),async c=>{
  const b=await c.req.json().catch(()=>null);
  const p=z.object({reason:z.string().min(5).max(1000),confirm:z.literal(true)}).safeParse(b);
  if(!p.success)return fail(c,400,"CONFIRMATION_REQUIRED","A reason and confirm=true are required.");
  try{
    const rows=await db(c.env).query<any>("SELECT id,source,source_post_id AS \"sourcePostId\",media_asset_id AS \"mediaAssetId\",thumbnail_media_id AS \"thumbnailMediaId\" FROM hof_discover_posts WHERE id=$1",[c.req.param("id")]);
    if(!rows.length)return fail(c,404,"NOT_FOUND","Post not found.");
    if(rows[0].sourcePostId)await db(c.env).query(`INSERT INTO hof_deleted_source_posts(source,source_post_id,reason)
      VALUES($1,$2,$3) ON CONFLICT(source,source_post_id) DO UPDATE SET reason=EXCLUDED.reason,deleted_at=now()`,
      [rows[0].source,rows[0].sourcePostId,p.data.reason]);
    await db(c.env).query("DELETE FROM hof_discover_reports WHERE post_id=$1",[c.req.param("id")]);
    await db(c.env).query("DELETE FROM hof_discover_posts WHERE id=$1",[c.req.param("id")]);
    for(const mediaId of [rows[0].mediaAssetId,rows[0].thumbnailMediaId].filter(Boolean)){
      const assets=await db(c.env).query<any>("SELECT object_key AS \"objectKey\",b2_file_id AS \"fileId\" FROM hof_media_assets WHERE id=$1",[mediaId]);
      if(assets.length&&assets[0].fileId){
        try{await deletePrivateB2Object(c.env,assets[0].fileId,assets[0].objectKey);await db(c.env).query("DELETE FROM hof_media_assets WHERE id=$1",[mediaId]);}
        catch{await db(c.env).query("UPDATE hof_media_assets SET status='deleted',visibility='private',deleted_at=now() WHERE id=$1",[mediaId]);}
      } else await db(c.env).query("DELETE FROM hof_media_assets WHERE id=$1",[mediaId]);
    }
    await db(c.env).query(`INSERT INTO hof_audit_logs(actor_subject,action,target_type,target_id,reason,request_id)
      VALUES('admin-api-key','discover.post.permanent_delete','discover_post',$1,$2,$3)`,[c.req.param("id"),p.data.reason,c.get("requestId")]);
    return ok(c,{id:c.req.param("id"),deleted:true});
  }catch{return fail(c,503,"DELETE_FAILED","Post deletion failed.");}
});

export { admin as discoverAdmin };
