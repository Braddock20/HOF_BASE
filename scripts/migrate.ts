import { readFile } from "node:fs/promises";
import { neon } from "@neondatabase/serverless";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("Set DATABASE_URL in your shell before migrating.");
const sql = neon(url);
const migration = await readFile(new URL("../migrations/0001_initial.sql", import.meta.url), "utf8");
await sql.query(`CREATE TABLE IF NOT EXISTS hof_schema_migrations(version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
const exists = await sql.query("SELECT version FROM hof_schema_migrations WHERE version=$1", ["0001_initial"]);
if (exists.length) {
  console.log("Migration 0001_initial already applied.");
} else {
  // Execute individual idempotent DDL/DML statements through Neon HTTP.
  // Run against staging first and take a backup before production.
  const statements = migration.split(";").map(x => x.trim()).filter(Boolean);
  for (const statement of statements) await sql.query(statement);
  await sql.query("INSERT INTO hof_schema_migrations(version) VALUES($1)", ["0001_initial"]);
  console.log(`Applied 0001_initial (${statements.length} statements).`);
}
