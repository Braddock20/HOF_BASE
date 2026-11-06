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
app.notFound(c => fail(c, 404, "NOT_FOUND", "The requested endpoint does not exist."));
app.onError((err, c) => {
  // Do not leak SQL, provider payloads, stack traces or secrets.
  console.error(JSON.stringify({ requestId: c.get("requestId"), error: err.name, message: "Unhandled request error" }));
  return fail(c, 500, "INTERNAL_ERROR", "An unexpected error occurred.");
});

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil((async () => {
      // Cleanup and TikTok synchronization are isolated so one task cannot
      // prevent the other from running or misreport its failure.
      try {
        await db(env).query("DELETE FROM hof_discover_feed_sessions WHERE expires_at < now()");
        await db(env).query("DELETE FROM hof_discover_seen_posts WHERE last_seen_at < now()-interval '90 days'");
      } catch {
        console.error(JSON.stringify({ task: "feed-session-cleanup", error: "cleanup_failed" }));
      }

      if (env.TIKTOK_SYNC_ENABLED === "true") {
        try {
          const result = await runScheduledCollection(env);
          console.log(JSON.stringify({ task: "tiktok-collection", result }));
        } catch {
          console.error(JSON.stringify({ task: "tiktok-collection", error: "collection_failed" }));
        }
      }
    })());
  }
};
