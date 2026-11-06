import { neon } from "@neondatabase/serverless";
import type { Env } from "./types";

export function db(env: Env) {
  if (!env.DATABASE_URL) throw new Error("DATABASE_URL is not configured");
  const sql = neon(env.DATABASE_URL);
  return {
    query<T = Record<string, unknown>>(text: string, params: unknown[] = []) {
      return sql.query(text, params) as Promise<T[]>;
    }
  };
}

export async function withTransaction<T>(
  env: Env,
  fn: (q: ReturnType<typeof db>["query"]) => Promise<T>
): Promise<T> {
  // Neon HTTP transactions use a single transactional SQL statement when possible.
  // Multi-statement sensitive mutations are implemented with a single CTE statement
  // so the state change and audit insert commit atomically.
  return fn(db(env).query);
}
