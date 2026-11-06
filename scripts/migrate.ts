import { readFile } from "node:fs/promises";
import { neon } from "@neondatabase/serverless";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("Set DATABASE_URL in your shell before migrating.");
const sql = neon(url);
await sql.query(`CREATE TABLE IF NOT EXISTS hof_schema_migrations(version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
for (const version of ["0001_initial", "0002_discover"]) {
  const exists = await sql.query("SELECT version FROM hof_schema_migrations WHERE version=$1", [version]);
  if (exists.length) {
    console.log(`Migration ${version} already applied.`);
    continue;
  }
  const migration = await readFile(new URL(`../migrations/${version}.sql`, import.meta.url), "utf8");
  const statements = migration.split(";").map(x => x.trim()).filter(Boolean);
  for (const statement of statements) await sql.query(statement);
  await sql.query("INSERT INTO hof_schema_migrations(version) VALUES($1)", [version]);
  console.log(`Applied ${version} (${statements.length} statements).`);
}
