import { Hono } from "hono";
import { z } from "zod";
import type { Env, AppVariables } from "./types";
import { db } from "./db";
import { fail, ok, slugify } from "./http";
import { requireAdmin, requirePermission } from "./auth";
import { refreshCreator, linkUnlinkedCreators } from "./creator-sync";
import { processQueuedJobs } from "./collector";

type E = { Bindings: Env; Variables: AppVariables };
export const creatorAdmin = new Hono<E>();
creatorAdmin.use("*", requireAdmin);
const usernameSchema = z.string().trim().min(2).max(100).transform(v => v.replace(/^@/, "").toLowerCase()).refine(v => /^[a-z0-9._]+$/.test(v), "Invalid TikTok username");

creatorAdmin.get("/", requirePermission("creator.manage"), async c => {
  const limit = Math.min(100, Math.max(1, Number(c.req.query("limit") || 30)));
  const offset = Math.max(0, Number(c.req.query("offset") || 0));
  const status = c.req.query("status");
  try {
    const rows = await db(c.env).query(`SELECT id,username,display_name AS "displayName",bio,profile_url AS "profileUrl",platform_user_id AS "platformUserId",sec_uid AS "secUid",avatar_url AS "avatarUrl",is_private AS "isPrivate",platform_verified AS "platformVerified",followers,following,video_count AS "videoCount",total_likes AS "totalLikes",status,provider_status AS "providerStatus",provider_message AS "providerMessage",last_synced_at AS "lastSyncedAt",created_at AS "createdAt",updated_at AS "updatedAt" FROM hof_tiktok_creators WHERE ($1::text IS NULL OR status=$1) ORDER BY created_at DESC LIMIT $2 OFFSET $3`, [status || null, limit, offset]);
    return ok(c, rows, 200, { limit, offset });
  } catch { return fail(c, 503, "DATABASE_UNAVAILABLE", "TikTok creators could not be loaded."); }
});

creatorAdmin.post("/", requirePermission("creator.manage"), async c => {
  const b = await c.req.json().catch(() => null);
  const p = z.object({ username: usernameSchema, displayName: z.string().trim().min(1).max(160).optional(), notes: z.string().max(1000).optional() }).safeParse(b);
  if (!p.success) return fail(c, 400, "VALIDATION_ERROR", "A valid TikTok username is required.");
  try {
    const rows = await db(c.env).query(`INSERT INTO hof_tiktok_creators(username,display_name,notes,created_by) VALUES($1,$2,$3,$4) RETURNING id,username,display_name AS "displayName",status,created_at AS "createdAt"`, [p.data.username, p.data.displayName || null, p.data.notes || null, c.get("subject") || "admin-api-key"]);
    await db(c.env).query(`INSERT INTO hof_audit_logs(actor_subject,action,target_type,target_id,request_id,after_state) VALUES($1,'tiktok.creator.add','tiktok_creator',$2,$3,$4::jsonb)`, [c.get("subject") || "admin-api-key", rows[0].id, c.get("requestId"), JSON.stringify({ username: p.data.username })]);
    let created: Record<string, unknown> = rows[0];
    let synced = false;
    try { created = { ...created, ...(await refreshCreator(c.env, String(rows[0].id), String(p.data.username))) }; synced = true; }
    catch { /* creator stays registered; the cron retries automatically */ }
    // Start the first video pull right away instead of waiting for the next cron tick.
    if (synced && c.env.TIKTOK_SYNC_ENABLED === "true") {
      try { c.executionCtx.waitUntil(processQueuedJobs(c.env, 1).catch(() => [])); } catch { /* no execution context; cron will pick it up */ }
    }
    return ok(c, created, 201, { synced });
  } catch { return fail(c, 409, "CONFLICT", "That TikTok username is already registered or could not be added."); }
});

creatorAdmin.get("/:id", requirePermission("creator.manage"), async c => {
  try {
    const rows = await db(c.env).query(`SELECT * FROM hof_tiktok_creators WHERE id=$1`, [c.req.param("id")]);
    if (!rows.length) return fail(c, 404, "NOT_FOUND", "TikTok creator not found.");
    return ok(c, rows[0]);
  } catch { return fail(c, 503, "DATABASE_UNAVAILABLE", "TikTok creator could not be loaded."); }
});

creatorAdmin.post("/link-all", requirePermission("creator.manage"), async c => {
  try { return ok(c, await linkUnlinkedCreators(c.env)); }
  catch { return fail(c, 503, "DATABASE_UNAVAILABLE", "Creators could not be linked."); }
});
creatorAdmin.post("/:id/refresh", requirePermission("creator.sync"), async c => {
  try {
    const existing = await db(c.env).query<{ username: string }>("SELECT username FROM hof_tiktok_creators WHERE id=$1 AND status='active'", [c.req.param("id")]);
    if (!existing.length) return fail(c, 404, "NOT_FOUND", "Active TikTok creator not found.");
    return ok(c, await refreshCreator(c.env, c.req.param("id"), existing[0].username));
  } catch (e) {
    const message = e instanceof Error ? e.message : "Provider request failed";
    const status = /IDENTITY_MISMATCH/.test(message) ? 502 : /rate limited/i.test(message) ? 429 : /not found/i.test(message) ? 404 : 502;
    return fail(c, status, "TIKTOK_REFRESH_FAILED", message);
  }
});
creatorAdmin.patch("/:id", requirePermission("creator.manage"), async c => {
  const b = await c.req.json().catch(() => null);
  const p = z.object({ displayName: z.string().trim().min(1).max(160).nullable().optional(), notes: z.string().max(1000).nullable().optional(), status: z.enum(["active","paused","blocked"]).optional() }).safeParse(b);
  if (!p.success || !Object.keys(p.data || {}).length) return fail(c, 400, "VALIDATION_ERROR", "No valid creator fields supplied.");
  try {
    const rows = await db(c.env).query(`UPDATE hof_tiktok_creators SET display_name=CASE WHEN $2::boolean THEN $3 ELSE display_name END,notes=CASE WHEN $4::boolean THEN $5 ELSE notes END,status=COALESCE($6,status),updated_at=now() WHERE id=$1 RETURNING id,username,display_name AS "displayName",notes,status,updated_at AS "updatedAt"`, [c.req.param("id"),p.data.displayName!==undefined,p.data.displayName??null,p.data.notes!==undefined,p.data.notes??null,p.data.status||null]);
    if (!rows.length) return fail(c, 404, "NOT_FOUND", "TikTok creator not found.");
    return ok(c, rows[0]);
  } catch { return fail(c, 503, "DATABASE_UNAVAILABLE", "TikTok creator update failed."); }
});
creatorAdmin.delete("/:id", requirePermission("creator.manage"), async c => {
  try {
    const rows = await db(c.env).query("UPDATE hof_tiktok_creators SET status='blocked',updated_at=now() WHERE id=$1 RETURNING id,username,status", [c.req.param("id")]);
    if (!rows.length) return fail(c,404,"NOT_FOUND","TikTok creator not found.");
    return ok(c,{...rows[0],deactivated:true});
  } catch { return fail(c,503,"DATABASE_UNAVAILABLE","TikTok creator could not be deactivated."); }
});

export const awardsPublic = new Hono<E>();
awardsPublic.get("/", async c => {
  try { return ok(c, await db(c.env).query(`SELECT id,name,slug,description,category,status,nomination_starts_at AS "nominationStartsAt",nomination_ends_at AS "nominationEndsAt",voting_starts_at AS "votingStartsAt",voting_ends_at AS "votingEndsAt",published_at AS "publishedAt" FROM hof_awards WHERE status IN ('nominations','voting','published','closed') ORDER BY created_at DESC`)); }
  catch { return fail(c,503,"DATABASE_UNAVAILABLE","Awards unavailable."); }
});
awardsPublic.get("/:slug", async c => {
  try {
    const rows = await db(c.env).query(`SELECT a.id,a.name,a.slug,a.description,a.category,a.status,a.nomination_starts_at AS "nominationStartsAt",a.nomination_ends_at AS "nominationEndsAt",a.voting_starts_at AS "votingStartsAt",a.voting_ends_at AS "votingEndsAt",a.published_at AS "publishedAt",COALESCE((SELECT json_agg(json_build_object('profileId',p.id,'displayName',p.display_name,'slug',p.slug,'status',n.status,'justification',n.justification)) FROM hof_nominations n JOIN hof_profiles p ON p.id=n.nominee_profile_id WHERE n.award_id=a.id AND n.status='approved'),'[]') AS nominees,COALESCE((SELECT json_agg(json_build_object('profileId',p.id,'displayName',p.display_name,'slug',p.slug,'place',w.place)) FROM hof_award_winners w JOIN hof_profiles p ON p.id=w.profile_id WHERE w.award_id=a.id),'[]') AS winners FROM hof_awards a WHERE a.slug=$1 AND a.status<>'draft'`, [c.req.param("slug")]);
    if (!rows.length) return fail(c,404,"NOT_FOUND","Award not found.");
    return ok(c,rows[0]);
  } catch { return fail(c,503,"DATABASE_UNAVAILABLE","Award could not be loaded."); }
});

export const awardsAdmin = new Hono<E>();
awardsAdmin.use("*", requireAdmin);
awardsAdmin.get("/",requirePermission("award.manage"),async c=>{try{return ok(c,await db(c.env).query("SELECT * FROM hof_awards ORDER BY created_at DESC"));}catch{return fail(c,503,"DATABASE_UNAVAILABLE","Awards unavailable.");}});
awardsAdmin.post("/",requirePermission("award.manage"),async c=>{
 const b=await c.req.json().catch(()=>null); const p=z.object({name:z.string().min(3).max(120),description:z.string().max(2000).optional(),category:z.string().max(100).optional(),nominationStartsAt:z.string().datetime().nullable().optional(),nominationEndsAt:z.string().datetime().nullable().optional(),votingStartsAt:z.string().datetime().nullable().optional(),votingEndsAt:z.string().datetime().nullable().optional(),eligibilityRules:z.record(z.string(),z.unknown()).optional()}).safeParse(b);
 if(!p.success)return fail(c,400,"VALIDATION_ERROR","Award details are invalid.");
 try{const rows=await db(c.env).query(`INSERT INTO hof_awards(name,slug,description,category,nomination_starts_at,nomination_ends_at,voting_starts_at,voting_ends_at,eligibility_rules) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) RETURNING *`,[p.data.name,slugify(p.data.name),p.data.description||null,p.data.category||null,p.data.nominationStartsAt||null,p.data.nominationEndsAt||null,p.data.votingStartsAt||null,p.data.votingEndsAt||null,JSON.stringify(p.data.eligibilityRules||{})]);return ok(c,rows[0],201);}catch{return fail(c,409,"CONFLICT","Award slug already exists or award could not be created.");}
});
awardsAdmin.patch("/:id/status",requirePermission("award.manage"),async c=>{
 const b=await c.req.json().catch(()=>null);const p=z.object({status:z.enum(["draft","nominations","voting","published","closed"]),reason:z.string().min(5).max(1000)}).safeParse(b);if(!p.success)return fail(c,400,"VALIDATION_ERROR","A valid status and reason are required.");
 try{const rows=await db(c.env).query(`UPDATE hof_awards SET status=$2,published_at=CASE WHEN $2='published' THEN COALESCE(published_at,now()) ELSE published_at END WHERE id=$1 RETURNING *`,[c.req.param("id"),p.data.status]);if(!rows.length)return fail(c,404,"NOT_FOUND","Award not found.");await db(c.env).query(`INSERT INTO hof_audit_logs(actor_subject,action,target_type,target_id,reason,request_id) VALUES($1,'award.status','award',$2,$3,$4)`,[c.get("subject"),p.data.reason,c.req.param("id"),c.get("requestId")]);return ok(c,rows[0]);}catch{return fail(c,503,"DATABASE_UNAVAILABLE","Award status update failed.");}
});
awardsAdmin.get("/:id/nominations",requirePermission("nomination.review"),async c=>{try{return ok(c,await db(c.env).query(`SELECT n.*,p.display_name AS "nomineeName",p.slug AS "nomineeSlug" FROM hof_nominations n JOIN hof_profiles p ON p.id=n.nominee_profile_id WHERE n.award_id=$1 ORDER BY n.created_at DESC`,[c.req.param("id")]));}catch{return fail(c,503,"DATABASE_UNAVAILABLE","Nominations unavailable.");}});
awardsAdmin.patch("/nominations/:id",requirePermission("nomination.review"),async c=>{const b=await c.req.json().catch(()=>null);const p=z.object({status:z.enum(["approved","rejected"]),reviewNote:z.string().min(3).max(1000)}).safeParse(b);if(!p.success)return fail(c,400,"VALIDATION_ERROR","A review status and note are required.");try{const rows=await db(c.env).query("UPDATE hof_nominations SET status=$2,reviewer_id=$3,review_note=$4 WHERE id=$1 RETURNING *",[c.req.param("id"),p.data.status,c.get("adminId"),p.data.reviewNote]);if(!rows.length)return fail(c,404,"NOT_FOUND","Nomination not found.");return ok(c,rows[0]);}catch{return fail(c,503,"DATABASE_UNAVAILABLE","Nomination review failed.");}});
awardsAdmin.post("/:id/winners",requirePermission("award.manage"),async c=>{const b=await c.req.json().catch(()=>null);const p=z.object({winners:z.array(z.object({profileId:z.string().uuid(),place:z.number().int().min(1).max(100)})).min(1).max(100),reason:z.string().min(5).max(1000)}).safeParse(b);if(!p.success)return fail(c,400,"VALIDATION_ERROR","Winner list is invalid.");try{const rows=await db(c.env).query(`INSERT INTO hof_award_winners(award_id,profile_id,place) SELECT $1,x.profile_id,x.place FROM jsonb_to_recordset($2::jsonb) AS x(profile_id uuid,place integer) RETURNING *`,[c.req.param("id"),JSON.stringify(p.data.winners.map(w=>({profile_id:w.profileId,place:w.place})))]);await db(c.env).query(`INSERT INTO hof_audit_logs(actor_subject,action,target_type,target_id,reason,request_id) VALUES($1,'award.winners.publish','award',$2,$3,$4)`,[c.get("subject"),c.req.param("id"),p.data.reason,c.get("requestId")]);return ok(c,rows,201);}catch{return fail(c,409,"CONFLICT","Winners could not be published; check duplicate places/profiles and award ID.");}});
