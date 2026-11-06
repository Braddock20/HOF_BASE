import { Hono } from "hono";
import type { Env, AppVariables } from "./types";
import { api } from "./routes";
import { requestId, securityHeaders, basicRateLimit } from "./middleware";
import { fail } from "./http";

const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
app.use("*", requestId, securityHeaders, basicRateLimit);
app.route("/api", api);
app.notFound(c => fail(c,404,"NOT_FOUND","The requested endpoint does not exist."));
app.onError((err,c) => {
  // Do not leak SQL, provider payloads, stack traces or secrets.
  console.error(JSON.stringify({ requestId:c.get("requestId"), error:err.name, message:"Unhandled request error" }));
  return fail(c,500,"INTERNAL_ERROR","An unexpected error occurred.");
});
export default app;
