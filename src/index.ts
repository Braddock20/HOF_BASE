import { Hono } from "hono";
import type { Env, AppVariables } from "./types";
import { api } from "./routes";
import { requestId, securityHeaders, basicRateLimit, restrictedCors } from "./middleware";
import { fail } from "./http";
import { db } from "./db";
import { runScheduledCollection } from "./collector";

const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
app.use("*", requestId, securityHeaders, restrictedCors, basicRateLimit);
app.route("/api", api);
app.notFound(c => fail(c,404,"NOT_FOUND","The requested endpoint does not exist."));
app.onError((err,c) => {
  // Do not leak SQL, provider payloads, stack traces or secrets.
  console.error(JSON.stringify({ requestId:c.get("requestId"), error:err.name, message:"Unhandled request error" }));
  return fail(c,500,"INTERNAL_ERROR","An unexpected error occurred.");
});
export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    // Expire feed snapshots in the background; scraper collection is separately
    // configured once the mother scraper's exact batch/post routes are supplied.
    ctx.waitUntil((async () => {
      try {
        await db(env).query("DELETE FROM hof_discover_feed_sessions WHERE expires_at < now()");
        await db(env).query("DELETE FROM hof_discover_seen_posts WHERE last_seen_at < now()-interval '90 days'");
        if (env.TIKTOK_SYNC_ENABLED === "true") {
          const result = await runScheduledCollection(env);
          console.log(JSON.stringify({ task: "tiktok-collection", result }));
        }
      } catch (error) {
        console.error(JSON.stringify({ task: "feed-session-cleanup", error: "cleanup_failed" }));
      }
    })());
  }
};
