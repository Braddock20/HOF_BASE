import { Hono } from "hono";
import type { Env, AppVariables } from "./types";
import { db } from "./db";
import { fail, ok } from "./http";

type E = { Bindings: Env; Variables: AppVariables };
export const leaderboard = new Hono<E>();

/** Whitelisted measures. `col` is the live column on hof_social_accounts, `snap` the column on the snapshot table.
 * These strings are the only things ever interpolated into SQL, so user input can never reach the query text. */
const BASES = {
  followers: { col: "followers", snap: "followers" },
  likes: { col: "total_likes", snap: "likes" },
  videos: { col: "video_count", snap: "videos" }
} as const;
type Base = keyof typeof BASES;
type Kind = "total" | "gain" | "loss" | "growth" | "change";

const WINDOWS: Record<string, string> = { "24h": "24 hours", "7d": "7 days", "30d": "30 days" };
const PLATFORMS = ["tiktok", "instagram", "youtube"];
const KINDS: Kind[] = ["gain", "loss", "growth", "change"];

export function parseMetric(value: string): { base: Base; kind: Kind } | null {
  const [name, suffix] = value.split("_");
  if (!(name in BASES)) return null;
  if (suffix === undefined) return { base: name as Base, kind: "total" };
  return KINDS.includes(suffix as Kind) ? { base: name as Base, kind: suffix as Kind } : null;
}

export function allMetrics(): string[] {
  const list: string[] = [];
  for (const base of Object.keys(BASES)) {
    list.push(base);
    for (const kind of KINDS) list.push(`${base}_${kind}`);
  }
  return list;
}

leaderboard.get("/metrics", c => ok(c, {
  metrics: allMetrics(),
  windows: Object.keys(WINDOWS),
  platforms: PLATFORMS,
  notes: {
    total: "followers, likes, videos: current value, highest first.",
    gain: "<metric>_gain: biggest increase over the window.",
    loss: "<metric>_loss: biggest drop over the window (largest loss first).",
    change: "<metric>_change: every account with history, signed change over the window (gains first, then flat, then losses); this is the stock-ticker view.",
    growth: "<metric>_growth: percentage increase over the window; accounts below minBase are excluded to avoid tiny-account noise.",
    params: "metric, window (24h|7d|30d), platform, limit (1-100), offset, minBase (growth only, default 100), strict=true (exclude accounts whose history is shorter than the window)."
  }
}));

leaderboard.get("/", async c => {
  const metricName = (c.req.query("metric") || "followers").toLowerCase();
  const parsed = parseMetric(metricName);
  if (!parsed) return fail(c, 400, "VALIDATION_ERROR", `Unknown metric. Use one of: ${allMetrics().join(", ")}.`);
  const windowKey = (c.req.query("window") || "7d").toLowerCase();
  if (!(windowKey in WINDOWS)) return fail(c, 400, "VALIDATION_ERROR", "window must be 24h, 7d or 30d.");
  const platform = (c.req.query("platform") || "tiktok").toLowerCase();
  if (!PLATFORMS.includes(platform)) return fail(c, 400, "VALIDATION_ERROR", "platform must be tiktok, instagram or youtube.");
  const limit = Math.min(100, Math.max(1, Number(c.req.query("limit") || 20) || 20));
  const offset = Math.max(0, Number(c.req.query("offset") || 0) || 0);
  const minBase = Math.max(0, Number(c.req.query("minBase") || 100) || 0);
  const strict = ["1", "true", "yes"].includes((c.req.query("strict") || "").toLowerCase());
  const { col, snap } = BASES[parsed.base];

  // Parameters are appended as they are used, so every $n in the SQL is always referenced.
  const params: unknown[] = [];
  const P = (value: unknown) => { params.push(value); return `$${params.length}`; };

  // Shared account list: public, active profiles only.
  const accounts = `acc AS (
    SELECT s.id, s.username, s.profile_url, s.avatar_url_temporary, s.last_synced_at,
           s.${col} AS cur_val, p.display_name AS profile_name, p.slug AS profile_slug
    FROM hof_social_accounts s JOIN hof_profiles p ON p.id=s.profile_id
    WHERE s.platform=${P(platform)} AND p.status='active' AND p.visibility='public' AND s.${col} IS NOT NULL
  )`;

  const shape = (extra: string) => `SELECT rank_no AS "rank", '#' || rank_no AS "rankLabel", username,
      profile_name AS "displayName", profile_slug AS "profileSlug", avatar_url_temporary AS "avatarUrl",
      profile_url AS "profileUrl", value, cur_val AS "current", ${extra} last_synced_at AS "lastSyncedAt",
      total_rows AS "total"`;

  try {
    let sql: string;
    if (parsed.kind === "total") {
      sql = `WITH ${accounts},
        ranked AS (SELECT acc.*, cur_val AS value, RANK() OVER (ORDER BY cur_val DESC) AS rank_no, count(*) OVER() AS total_rows FROM acc)
        ${shape("")} FROM ranked ORDER BY rank_no, username LIMIT ${P(limit)} OFFSET ${P(offset)}`;
    } else {
      // previous = newest snapshot at or before the window start; if history is shorter than the window,
      // fall back to the oldest snapshot that is at least 1 hour old and flag the row as a partial window.
      const interval = P(WINDOWS[windowKey]);
      const strictParam = P(strict);
      const growthCte = `, base AS (
        SELECT acc.*, b.v AS prev_val, b.captured_at AS prev_at, b.partial
        FROM acc JOIN LATERAL (
          SELECT * FROM (
            (SELECT m.${snap} AS v, m.captured_at, false AS partial FROM hof_social_metric_snapshots m
              WHERE m.social_account_id=acc.id AND m.${snap} IS NOT NULL AND m.captured_at <= now() - ${interval}::interval
              ORDER BY m.captured_at DESC LIMIT 1)
            UNION ALL
            (SELECT m.${snap}, m.captured_at, true FROM hof_social_metric_snapshots m
              WHERE m.social_account_id=acc.id AND m.${snap} IS NOT NULL AND m.captured_at <= now() - interval '1 hour'
              ORDER BY m.captured_at ASC LIMIT 1)
          ) x ORDER BY x.partial ASC LIMIT 1
        ) b ON true
        WHERE (${strictParam}::boolean = false OR b.partial = false)
      ), calc AS (
        SELECT base.*, (cur_val - prev_val) AS change,
               CASE WHEN prev_val > 0 THEN round((cur_val - prev_val)::numeric * 100 / prev_val, 2) END AS growth_pct
        FROM base
      )`;
      const where = parsed.kind === "gain" ? "change > 0"
        : parsed.kind === "loss" ? "change < 0"
        : parsed.kind === "change" ? "change IS NOT NULL"
        : `growth_pct IS NOT NULL AND change > 0 AND prev_val >= ${P(minBase)}::bigint`;
      const valueExpr = parsed.kind === "gain" || parsed.kind === "change" ? "change" : parsed.kind === "loss" ? "(-change)" : "growth_pct";
      const orderExpr = parsed.kind === "loss" ? "change ASC" : parsed.kind === "gain" || parsed.kind === "change" ? "change DESC" : "growth_pct DESC";
      const extra = `prev_val AS "previous", change, growth_pct AS "growthPct", partial AS "partialWindow", prev_at AS "baselineAt",`;
      sql = `WITH ${accounts}${growthCte},
        ranked AS (SELECT calc.*, ${valueExpr} AS value, RANK() OVER (ORDER BY ${orderExpr}) AS rank_no, count(*) OVER() AS total_rows
                   FROM calc WHERE ${where})
        ${shape(extra)} FROM ranked ORDER BY rank_no, username LIMIT ${P(limit)} OFFSET ${P(offset)}`;
    }

    const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
    const rows = await db(c.env).query<any>(sql, params);
    const total = rows.length ? Number(rows[0].total) : 0;
    c.header("Cache-Control", "public, max-age=60");
    return ok(c, rows.map(({ total: _t, ...r }: any) => ({
      ...r, rank: Number(r.rank), value: num(r.value), current: num(r.current),
      ...(parsed.kind === "total" ? {} : { previous: num(r.previous), change: num(r.change), growthPct: num(r.growthPct) })
    })), 200, {
      metric: metricName, window: parsed.kind === "total" ? null : windowKey, platform, limit, offset, total,
      generatedAt: new Date().toISOString(),
      note: parsed.kind === "total" ? null : "Growth is computed from stored metric snapshots. Rows with partialWindow=true have less history than the requested window; add strict=true to exclude them."
    });
  } catch (error) {
    console.error("leaderboard_failed", error instanceof Error ? error.message : String(error));
    return fail(c, 503, "DATABASE_UNAVAILABLE", "Leaderboard unavailable.");
  }
});
