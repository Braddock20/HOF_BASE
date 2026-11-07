import { Hono } from "hono";
import { z } from "zod";
import type { Env, AppVariables } from "./types";
import { db } from "./db";
import { fail, ok, requiredString, slugify } from "./http";
import { requireAdmin, requirePermission } from "./auth";
import { discover as discoverRoutes, discoverAdmin, media as mediaRoutes } from "./discover";
import { creatorAdmin, awardsPublic, awardsAdmin } from "./creators";
import { leaderboard } from "./leaderboard";

type E = { Bindings: Env; Variables: AppVariables };
const AV = `(SELECT s2.avatar_url_temporary FROM hof_social_accounts s2 WHERE s2.profile_id=p.id AND s2.avatar_url_temporary IS NOT NULL ORDER BY (s2.platform='tiktok') DESC LIMIT 1) AS "avatarUrl",(SELECT max(s3.followers) FROM hof_social_accounts s3 WHERE s3.profile_id=p.id) AS followers`;
export const api = new Hono<E>();

const pagination = (c: any) => ({
  limit: Math.min(50, Math.max(1, Number(c.req.query("limit") || 20))),
  offset: Math.max(0, Number(c.req.query("offset") || 0))
});

api.get("/health", c => ok(c, { service: "hof-api", status: "ok", environment: c.env.APP_ENV || "unknown", time: new Date().toISOString() }));
api.get("/health/db", async c => {
  try {
    const rows = await db(c.env).query<{ now: string }>("SELECT now() AS now");
    return ok(c, { connected: true, databaseTime: rows[0].now });
  } catch {
    return fail(c, 503, "DATABASE_UNAVAILABLE", "Database connectivity check failed.");
  }
});
api.get("/health/tiktok", c => ok(c, {
  configured: Boolean(c.env.TIKTOK_SCRAPER_BASE_URL),
  profilePathConfigured: Boolean(c.env.TIKTOK_PROFILE_PATH || "/api/profile"),
  postsPathConfigured: Boolean(c.env.TIKTOK_POSTS_PATH),
  syncEnabled: c.env.TIKTOK_SYNC_ENABLED === "true",
  probe: "deferred-until-profile-refresh",
  note: "The scraper does not expose a dedicated /api/health route; use a creator refresh to verify live connectivity."
}));
api.get("/version", c => ok(c, { name: "hof-api", version: "1.2.10", build: "auto-link-multi-pull" }));
api.route("/discover", discoverRoutes);
api.route("/media", mediaRoutes);
api.route("/admin/discover", discoverAdmin);
api.route("/awards", awardsPublic);
api.route("/leaderboard", leaderboard);

api.get("/profiles", async c => {
  const { limit, offset } = pagination(c);
  try {
    const rows = await db(c.env).query(
      `SELECT p.id, p.display_name AS "displayName", p.slug, p.bio, ${AV}, p.created_at AS "createdAt",
       (SELECT json_agg(json_build_object('platform',s.platform,'username',s.username,'profileUrl',s.profile_url,
          'followers',s.followers,'lastSyncedAt',s.last_synced_at)) FROM hof_social_accounts s WHERE s.profile_id=p.id) AS "socialAccounts"
       FROM hof_profiles p WHERE p.status='active' AND p.visibility='public'
       ORDER BY p.created_at DESC LIMIT $1 OFFSET $2`, [limit, offset]);
    return ok(c, rows, 200, { limit, offset });
  } catch { return fail(c, 503, "DATABASE_UNAVAILABLE", "Profiles could not be loaded."); }
});

api.get("/profiles/:slug", async c => {
  try {
    const rows = await db(c.env).query(
      `SELECT p.id,p.display_name AS "displayName",p.slug,p.bio,${AV},p.created_at AS "createdAt",p.updated_at AS "updatedAt",
       json_build_object('identity', COALESCE((SELECT status FROM hof_verifications v WHERE v.profile_id=p.id AND verification_type='identity'),'pending'),
                         'campus', COALESCE((SELECT status FROM hof_verifications v WHERE v.profile_id=p.id AND verification_type='campus'),'pending')) AS verifications,
       COALESCE((SELECT json_agg(json_build_object('id',r.id,'name',r.name,'slug',r.slug,'description',r.description,'badgeColor',r.badge_color,'textColor',r.text_color,'icon',r.icon))
         FROM hof_profile_ranks pr JOIN hof_ranks r ON r.id=pr.rank_id WHERE pr.profile_id=p.id AND pr.status='active' AND r.is_active AND (pr.expires_at IS NULL OR pr.expires_at>now())), '[]') AS ranks,
       COALESCE((SELECT json_agg(json_build_object('platform',s.platform,'username',s.username,'profileUrl',s.profile_url,'platformVerified',s.platform_verified,'isPrivate',s.is_private,
         'metrics',json_build_object('followers',s.followers,'following',s.following,'videos',s.video_count,'likes',s.total_likes),
         'metricsAvailability',s.metrics_availability,'lastSyncedAt',s.last_synced_at)) FROM hof_social_accounts s WHERE s.profile_id=p.id),'[]') AS "socialAccounts"
       FROM hof_profiles p WHERE p.slug=$1 AND p.status='active' AND p.visibility IN ('public','unlisted') LIMIT 1`, [c.req.param("slug")]);
    if (!rows.length) return fail(c, 404, "NOT_FOUND", "Profile not found.");
    return ok(c, rows[0]);
  } catch { return fail(c, 503, "DATABASE_UNAVAILABLE", "Profile could not be loaded."); }
});

api.get("/search", async c => {
  const q = (c.req.query("q") || "").trim().slice(0, 100);
  if (!q) return ok(c, []);
  try {
    const rows = await db(c.env).query(
      `SELECT DISTINCT p.id,p.display_name AS "displayName",p.slug,p.bio,${AV}
       FROM hof_profiles p LEFT JOIN hof_social_accounts s ON s.profile_id=p.id
       LEFT JOIN hof_profile_categories pc ON pc.profile_id=p.id LEFT JOIN hof_categories cat ON cat.id=pc.category_id
       WHERE p.status='active' AND p.visibility='public'
       AND (p.display_name ILIKE $1 OR p.slug ILIKE $1 OR s.username ILIKE $1 OR cat.name ILIKE $1)
       ORDER BY p.display_name LIMIT 30`, [`%${q}%`]);
    return ok(c, rows);
  } catch { return fail(c, 503, "DATABASE_UNAVAILABLE", "Search is temporarily unavailable."); }
});

api.get("/categories", async c => {
  try { return ok(c, await db(c.env).query("SELECT id,name,slug,description FROM hof_categories WHERE is_active ORDER BY display_order,name")); }
  catch { return fail(c,503,"DATABASE_UNAVAILABLE","Categories unavailable."); }
});
api.get("/categories/:slug", async c => {
  try {
    const rows = await db(c.env).query(
      `SELECT p.id,p.display_name AS "displayName",p.slug,p.bio,${AV} FROM hof_profiles p
       JOIN hof_profile_categories pc ON pc.profile_id=p.id JOIN hof_categories cat ON cat.id=pc.category_id
       WHERE cat.slug=$1 AND cat.is_active AND p.status='active' AND p.visibility='public'
       ORDER BY p.display_name`, [c.req.param("slug")]);
    return ok(c, rows);
  } catch { return fail(c,503,"DATABASE_UNAVAILABLE","Category could not be loaded."); }
});
api.get("/sections", async c => {
  try { return ok(c, await db(c.env).query("SELECT id,name,slug,description,max_items FROM hof_display_sections WHERE is_active ORDER BY display_order")); }
  catch { return fail(c,503,"DATABASE_UNAVAILABLE","Sections unavailable."); }
});
api.get("/sections/:slug", async c => {
  try {
    const rows = await db(c.env).query(
      `SELECT p.id,p.display_name AS "displayName",p.slug,p.bio,${AV},si.position
       FROM hof_section_items si JOIN hof_display_sections ds ON ds.id=si.section_id
       JOIN hof_profiles p ON p.id=si.profile_id
       WHERE ds.slug=$1 AND ds.is_active AND p.status='active' AND p.visibility='public'
       AND (si.starts_at IS NULL OR si.starts_at<=now()) AND (si.ends_at IS NULL OR si.ends_at>now())
       ORDER BY si.position LIMIT (SELECT max_items FROM hof_display_sections WHERE slug=$1)`, [c.req.param("slug")]);
    return ok(c, rows);
  } catch { return fail(c,503,"DATABASE_UNAVAILABLE","Section could not be loaded."); }
});
api.get("/featured", c => c.redirect("/api/sections/featured-personalities", 307));
api.get("/trending", async c => {
  // Intentionally no fabricated trend score. Snapshot-backed trending is a later enabled feature.
  return ok(c, { status: "not_yet_eligible", message: "Trending appears when sufficient reliable metric snapshots exist.", items: [] });
});
api.get("/rankings", async c => {
  try { return ok(c, await db(c.env).query("SELECT slug,name,description FROM hof_ranks WHERE is_active ORDER BY display_order,name")); }
  catch { return fail(c,503,"DATABASE_UNAVAILABLE","Rankings unavailable."); }
});
api.get("/rankings/:slug", async c => {
  try {
    const rows = await db(c.env).query(
      `SELECT p.display_name AS "displayName",p.slug,${AV},r.name AS rank,r.badge_color AS "badgeColor",pr.assigned_at AS "assignedAt"
       FROM hof_profile_ranks pr JOIN hof_ranks r ON r.id=pr.rank_id JOIN hof_profiles p ON p.id=pr.profile_id
       WHERE r.slug=$1 AND r.is_active AND pr.status='active' AND (pr.expires_at IS NULL OR pr.expires_at>now())
       AND p.status='active' AND p.visibility='public' ORDER BY pr.assigned_at DESC`, [c.req.param("slug")]);
    return ok(c, rows);
  } catch { return fail(c,503,"DATABASE_UNAVAILABLE","Ranking unavailable."); }
});

api.get("/platforms", c => ok(c, [{ id: "tiktok", name: "TikTok", discovery: true }, { id: "instagram", name: "Instagram", discovery: false }, { id: "youtube", name: "YouTube", discovery: false }]));

// User-submitted nominations and reports are intentionally deferred until a
// first-party student identity/abuse-control design is implemented.
api.post("/nominations", c => fail(c, 400, "USE_CREATOR_REQUESTS", "Use POST /api/discover/creator-requests to suggest a creator."));
api.post("/reports", c => fail(c, 400, "USE_DISCOVER_REPORTS", "Use POST /api/discover/reports to report a Discover post."));

// Protected admin API
const admin = new Hono<E>();
admin.use("*", requireAdmin);
admin.get("/me", c => ok(c, { authentication: "api-key", administrator: "super-admin", permissions: [...(c.get("permissions") || [])] }));
admin.get("/profiles", requirePermission("profile.view"), async c => {
  const { limit, offset } = pagination(c);
  try {
    const rows = await db(c.env).query("SELECT p.id,p.display_name AS \"displayName\",p.slug,p.status,p.visibility,p.bio,sa.username AS \"tiktokUsername\",sa.avatar_url_temporary AS \"avatarUrl\",sa.followers,sa.following,sa.video_count AS \"videoCount\",sa.total_likes AS \"totalLikes\",sa.provider_status AS \"providerStatus\",sa.last_synced_at AS \"lastSyncedAt\",p.created_at AS \"createdAt\" FROM hof_profiles p LEFT JOIN LATERAL (SELECT * FROM hof_social_accounts s WHERE s.profile_id=p.id AND s.platform='tiktok' ORDER BY s.created_at LIMIT 1) sa ON true ORDER BY p.created_at DESC LIMIT $1 OFFSET $2",[limit,offset]);
    return ok(c,rows,200,{limit,offset});
  } catch { return fail(c,503,"DATABASE_UNAVAILABLE","Admin profiles unavailable."); }
});
admin.post("/profiles", requirePermission("profile.edit"), async c => {
  const b = await c.req.json().catch(() => null) as any;
  const p = z.object({ displayName:z.string().min(2).max(120), bio:z.string().max(2000).optional(), slug:z.string().min(2).max(80).optional(), status:z.enum(["pending","active"]).default("pending") }).safeParse(b);
  if (!p.success) return fail(c,400,"VALIDATION_ERROR","Profile details are invalid.");
  const slug = p.data.slug ? slugify(p.data.slug) : slugify(p.data.displayName);
  try {
    const rows = await db(c.env).query(
      `WITH ins AS (INSERT INTO hof_profiles(display_name,slug,bio,status) VALUES($1,$2,$3,$4) RETURNING *)
       SELECT id,display_name AS "displayName",slug,status FROM ins`,
      [p.data.displayName,slug,p.data.bio || null,p.data.status]);
    return ok(c,rows[0],201);
  } catch { return fail(c,409,"CONFLICT","Profile slug already exists or profile could not be created."); }
});
admin.patch("/profiles/:id", requirePermission("profile.edit"), async c => {
  const b = await c.req.json().catch(() => null) as any;
  const p = z.object({ displayName:z.string().min(2).max(120).optional(), bio:z.string().max(2000).nullable().optional(), visibility:z.enum(["public","unlisted","hidden"]).optional() }).safeParse(b);
  if (!p.success || !Object.keys(p.data || {}).length) return fail(c,400,"VALIDATION_ERROR","No valid profile fields supplied.");
  try {
    const rows = await db(c.env).query(
      `UPDATE hof_profiles SET display_name=COALESCE($2,display_name),bio=CASE WHEN $3::boolean THEN $4 ELSE bio END,
       visibility=COALESCE($5,visibility),updated_at=now() WHERE id=$1 RETURNING id,display_name AS "displayName",slug,bio,status,visibility`,
      [c.req.param("id"),p.data.displayName || null,p.data.bio !== undefined,p.data.bio ?? null,p.data.visibility || null]);
    if (!rows.length) return fail(c,404,"NOT_FOUND","Profile not found.");
    return ok(c,rows[0]);
  } catch { return fail(c,503,"DATABASE_UNAVAILABLE","Profile update failed."); }
});

admin.post("/profiles/:id/verify/:type", async c => {
  const type = c.req.param("type");
  if (!["identity","campus"].includes(type)) return fail(c,400,"VALIDATION_ERROR","Verification type must be identity or campus.");
  const permission = type === "identity" ? "profile.verify.identity" : "profile.verify.campus";
  if (!c.get("permissions")?.has(permission)) return fail(c,403,"FORBIDDEN","Missing verification permission.");
  const b = await c.req.json().catch(() => null) as any;
  if (!requiredString(b?.reason,1000)) return fail(c,400,"VALIDATION_ERROR","A reason is required.");
  try {
    const rows = await db(c.env).query(
      `WITH up AS (
        INSERT INTO hof_verifications(profile_id,verification_type,status,verified_by,verified_at,reason,evidence_ref)
        VALUES($1,$2,'verified',$3,now(),$4,$5)
        ON CONFLICT(profile_id,verification_type) DO UPDATE SET status='verified',verified_by=$3,verified_at=now(),reason=$4,evidence_ref=$5,updated_at=now()
        RETURNING *
      ), hist AS (
        INSERT INTO hof_verification_history(profile_id,verification_type,previous_status,new_status,actor_admin_id,reason,evidence_ref)
        SELECT profile_id,verification_type,NULL,'verified',$3,$4,$5 FROM up RETURNING id
      ), audit AS (
        INSERT INTO hof_audit_logs(actor_admin_id,actor_subject,action,target_type,target_id,reason,request_id,after_state)
        SELECT $3,$6,'profile.verify.'||$2,'profile',$1,$4,$7,json_build_object('type',$2,'status','verified') FROM up RETURNING id
      ) SELECT id,verification_type AS type,status,verified_at AS "verifiedAt" FROM up`,
      [c.req.param("id"),type,c.get("adminId"),b.reason,b.evidenceRef || null,c.get("subject"),c.get("requestId")]);
    if (!rows.length) return fail(c,404,"NOT_FOUND","Profile not found.");
    return ok(c,rows[0]);
  } catch { return fail(c,503,"DATABASE_UNAVAILABLE","Verification action failed."); }
});

async function moderation(c: any, action: string, status: string) {
  const b = await c.req.json().catch(() => null) as any;
  if (!requiredString(b?.reason,1000) || b?.confirm !== true) return fail(c,400,"VALIDATION_ERROR","A reason and explicit confirm=true are required.");
  try {
    const rows = await db(c.env).query(
      `WITH upd AS (UPDATE hof_profiles SET status=$2,removed_at=CASE WHEN $2='removed' THEN now() WHEN $2='active' THEN NULL ELSE removed_at END,
        blocked_at=CASE WHEN $2='blocked' THEN now() WHEN $2='active' THEN NULL ELSE blocked_at END,updated_at=now()
        WHERE id=$1 RETURNING id,status),
       mod AS (INSERT INTO hof_moderation_actions(profile_id,action,reason,actor_admin_id) SELECT id,$3,$4,$5 FROM upd RETURNING id),
       aud AS (INSERT INTO hof_audit_logs(actor_admin_id,actor_subject,action,target_type,target_id,reason,request_id)
        SELECT $5,$6,$3,'profile',$1,$4,$7 FROM upd RETURNING id)
       SELECT * FROM upd`,
      [c.req.param("id"),status,action,b.reason,c.get("adminId"),c.get("subject"),c.get("requestId")]);
    if (!rows.length) return fail(c,404,"NOT_FOUND","Profile not found.");
    return ok(c,rows[0]);
  } catch { return fail(c,503,"DATABASE_UNAVAILABLE","Moderation action failed."); }
}
for (const [action,status,permission] of [
  ["block","blocked","profile.block"],["unblock","active","profile.unblock"],
  ["remove","removed","profile.remove"],["restore","active","profile.restore"]
] as const) admin.post(`/profiles/:id/${action}`,requirePermission(permission),c=>moderation(c,action,status));

admin.get("/categories",requirePermission("category.manage"),async c=>{
  try{return ok(c,await db(c.env).query("SELECT id,name,slug,description,is_active AS \"isActive\",display_order AS \"displayOrder\" FROM hof_categories ORDER BY display_order,name"));}
  catch{return fail(c,503,"DATABASE_UNAVAILABLE","Admin categories unavailable.");}
});
admin.post("/categories",requirePermission("category.manage"),async c=>{
  const b=await c.req.json().catch(()=>null);
  const p=z.object({name:z.string().min(2).max(80),description:z.string().max(500).optional(),displayOrder:z.number().int().min(0).max(10000).default(0)}).safeParse(b);
  if(!p.success)return fail(c,400,"VALIDATION_ERROR","Category details are invalid.");
  try{
    const rows=await db(c.env).query(`INSERT INTO hof_categories(name,slug,description,display_order)
      VALUES($1,$2,$3,$4) RETURNING id,name,slug,description,is_active AS "isActive",display_order AS "displayOrder"`,
      [p.data.name,slugify(p.data.name),p.data.description||null,p.data.displayOrder]);
    await db(c.env).query(`INSERT INTO hof_audit_logs(actor_subject,action,target_type,target_id,request_id)
      VALUES('admin-api-key','category.create','category',$1,$2)`,[rows[0].id,c.get("requestId")]);
    return ok(c,rows[0],201);
  }catch{return fail(c,409,"CONFLICT","Category slug already exists or category could not be created.");}
});
admin.patch("/categories/:id",requirePermission("category.manage"),async c=>{
  const b=await c.req.json().catch(()=>null);
  const p=z.object({name:z.string().min(2).max(80).optional(),description:z.string().max(500).nullable().optional(),isActive:z.boolean().optional(),displayOrder:z.number().int().min(0).max(10000).optional()}).safeParse(b);
  if(!p.success||!Object.keys(p.data||{}).length)return fail(c,400,"VALIDATION_ERROR","Category update is invalid.");
  try{
    const rows=await db(c.env).query(`UPDATE hof_categories SET name=COALESCE($2,name),slug=CASE WHEN $2::text IS NULL THEN slug ELSE $3 END,
      description=CASE WHEN $4::boolean THEN $5 ELSE description END,is_active=COALESCE($6,is_active),
      display_order=COALESCE($7,display_order) WHERE id=$1 RETURNING id,name,slug,description,is_active AS "isActive",display_order AS "displayOrder"`,
      [c.req.param("id"),p.data.name||null,p.data.name?slugify(p.data.name):null,p.data.description!==undefined,p.data.description??null,p.data.isActive??null,p.data.displayOrder??null]);
    if(!rows.length)return fail(c,404,"NOT_FOUND","Category not found.");
    return ok(c,rows[0]);
  }catch{return fail(c,409,"CONFLICT","Category update failed.");}
});
admin.post("/profiles/:id/categories",requirePermission("category.manage"),async c=>{
  const b=await c.req.json().catch(()=>null);
  const p=z.object({categoryId:z.string().uuid()}).safeParse(b);
  if(!p.success)return fail(c,400,"VALIDATION_ERROR","A valid categoryId is required.");
  try{
    const rows=await db(c.env).query(`INSERT INTO hof_profile_categories(profile_id,category_id)
      SELECT $1,$2 WHERE EXISTS(SELECT 1 FROM hof_profiles WHERE id=$1)
      AND EXISTS(SELECT 1 FROM hof_categories WHERE id=$2 AND is_active)
      ON CONFLICT DO NOTHING RETURNING profile_id,category_id`,[c.req.param("id"),p.data.categoryId]);
    if(!rows.length)return fail(c,409,"CONFLICT","Profile/category is invalid or already assigned.");
    await db(c.env).query(`INSERT INTO hof_audit_logs(actor_subject,action,target_type,target_id,request_id)
      VALUES('admin-api-key','profile.category.assign','profile',$1,$2)`,[c.req.param("id"),c.get("requestId")]);
    return ok(c,rows[0],201);
  }catch{return fail(c,503,"DATABASE_UNAVAILABLE","Category assignment failed.");}
});

admin.delete("/profiles/:id/categories/:categoryId",requirePermission("category.manage"),async c=>{
  try{
    const rows=await db(c.env).query("DELETE FROM hof_profile_categories WHERE profile_id=$1 AND category_id=$2 RETURNING profile_id,category_id",[c.req.param("id"),c.req.param("categoryId")]);
    if(!rows.length)return fail(c,404,"NOT_FOUND","Profile category assignment not found.");
    await db(c.env).query(`INSERT INTO hof_audit_logs(actor_subject,action,target_type,target_id,request_id)
      VALUES('admin-api-key','profile.category.remove','profile',$1,$2)`,[c.req.param("id"),c.get("requestId")]);
    return ok(c,{removed:true});
  }catch{return fail(c,503,"DATABASE_UNAVAILABLE","Category removal failed.");}
});

admin.get("/ranks",requirePermission("rank.view"),async c=>{
  try{return ok(c,await db(c.env).query("SELECT * FROM hof_ranks ORDER BY display_order,name"));}
  catch{return fail(c,503,"DATABASE_UNAVAILABLE","Ranks unavailable.");}
});
admin.post("/ranks",requirePermission("rank.create"),async c=>{
  const b=await c.req.json().catch(()=>null) as any;
  const p=z.object({name:z.string().min(2).max(80),description:z.string().max(500).optional(),badgeColor:z.string().regex(/^#[0-9a-fA-F]{6}$/),textColor:z.string().regex(/^#[0-9a-fA-F]{6}$/),icon:z.string().max(40).optional()}).safeParse(b);
  if(!p.success)return fail(c,400,"VALIDATION_ERROR","Rank details or colours are invalid.");
  try{
    const rows=await db(c.env).query(
      `WITH r AS (INSERT INTO hof_ranks(name,slug,description,badge_color,text_color,icon,created_by)
       VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *),
       a AS (INSERT INTO hof_audit_logs(actor_admin_id,actor_subject,action,target_type,target_id,after_state)
       SELECT $7,$8,'rank.create','rank',id::text,to_jsonb(r) FROM r)
       SELECT * FROM r`,
      [p.data.name,slugify(p.data.name),p.data.description||null,p.data.badgeColor,p.data.textColor,p.data.icon||null,c.get("adminId"),c.get("subject")]);
    return ok(c,rows[0],201);
  }catch{return fail(c,409,"CONFLICT","Rank slug already exists or rank could not be created.");}
});
admin.patch("/ranks/:id",requirePermission("rank.edit"),async c=>{
  const b=await c.req.json().catch(()=>null) as any;
  const p=z.object({name:z.string().min(2).max(80).optional(),description:z.string().max(500).nullable().optional(),badgeColor:z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),textColor:z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),icon:z.string().max(40).nullable().optional(),isActive:z.boolean().optional()}).safeParse(b);
  if(!p.success)return fail(c,400,"VALIDATION_ERROR","Rank update is invalid.");
  try{
    const rows=await db(c.env).query(`UPDATE hof_ranks SET name=COALESCE($2,name),description=COALESCE($3,description),
      badge_color=COALESCE($4,badge_color),text_color=COALESCE($5,text_color),icon=CASE WHEN $6::boolean THEN $7 ELSE icon END,
      is_active=COALESCE($8,is_active),updated_at=now() WHERE id=$1 RETURNING *`,
      [c.req.param("id"),p.data.name||null,p.data.description??null,p.data.badgeColor||null,p.data.textColor||null,p.data.icon!==undefined,p.data.icon??null,p.data.isActive??null]);
    if(!rows.length)return fail(c,404,"NOT_FOUND","Rank not found.");
    return ok(c,rows[0]);
  }catch{return fail(c,503,"DATABASE_UNAVAILABLE","Rank update failed.");}
});
admin.post("/profiles/:id/ranks",requirePermission("rank.assign"),async c=>{
  const b=await c.req.json().catch(()=>null) as any;
  const p=z.object({rankId:z.string().uuid(),reason:z.string().min(5).max(1000),expiresAt:z.string().datetime().nullable().optional()}).safeParse(b);
  if(!p.success)return fail(c,400,"VALIDATION_ERROR","Rank assignment is invalid.");
  try{
    const rows=await db(c.env).query(
      `WITH ins AS (INSERT INTO hof_profile_ranks(profile_id,rank_id,assigned_by,expires_at,reason)
       SELECT $1,$2,$3,$4,$5 WHERE EXISTS(SELECT 1 FROM hof_profiles WHERE id=$1 AND status='active')
       ON CONFLICT DO NOTHING RETURNING *),
       aud AS (INSERT INTO hof_audit_logs(actor_admin_id,actor_subject,action,target_type,target_id,reason,request_id)
       SELECT $3,$6,'rank.assign','profile',$1,$5,$7 FROM ins)
       SELECT * FROM ins`,
      [c.req.param("id"),p.data.rankId,c.get("adminId"),p.data.expiresAt||null,p.data.reason,c.get("subject"),c.get("requestId")]);
    if(!rows.length)return fail(c,409,"CONFLICT","Profile/rank is invalid or assignment already exists.");
    return ok(c,rows[0],201);
  }catch{return fail(c,503,"DATABASE_UNAVAILABLE","Rank assignment failed.");}
});
admin.get("/audit-logs",requirePermission("audit.view"),async c=>{
  const {limit,offset}=pagination(c);
  try{return ok(c,await db(c.env).query("SELECT id,actor_subject AS actor,action,target_type AS \"targetType\",target_id AS \"targetId\",reason,request_id AS \"requestId\",created_at AS \"createdAt\" FROM hof_audit_logs ORDER BY created_at DESC LIMIT $1 OFFSET $2",[limit,offset]),200,{limit,offset});}
  catch{return fail(c,503,"DATABASE_UNAVAILABLE","Audit logs unavailable.");}
});

admin.route("/tiktok-creators", creatorAdmin);
admin.route("/awards", awardsAdmin);
api.route("/admin",admin);
