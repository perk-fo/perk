import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Db } from "./client";

const MIGRATIONS_DIR = resolve(import.meta.dir, "../../migrations");

/**
 * Apply every migrations/NNNN_*.sql not yet recorded in schema_migrations, in order, each in its own
 * transaction. Safe to run on every boot.
 */
export async function migrate(db: Db, dir = MIGRATIONS_DIR): Promise<string[]> {
  await db`create table if not exists schema_migrations (
    version integer primary key,
    name text not null,
    applied_at timestamptz not null default now()
  )`;
  const applied = new Set(
    (await db<{ version: number }[]>`select version from schema_migrations`).map((r) => Number(r.version)),
  );
  const files = readdirSync(dir)
    .filter((f) => /^\d{4}_.*\.sql$/.test(f))
    .sort();
  const ran: string[] = [];
  for (const file of files) {
    const version = Number(file.slice(0, 4));
    if (applied.has(version)) continue;
    const sql = readFileSync(resolve(dir, file), "utf8");
    await db.begin(async (tx) => {
      await tx.unsafe(sql);
      await tx`insert into schema_migrations (version, name) values (${version}, ${file})`;
    });
    ran.push(file);
  }
  return ran;
}

if (import.meta.main) {
  const { loadConfig, loadDotenv } = await import("../config");
  const { createDb } = await import("./client");
  loadDotenv();
  const cfg = loadConfig();
  const db = createDb(cfg.databaseUrl, { max: 1 });
  const ran = await migrate(db);
  console.log(ran.length ? `applied: ${ran.join(", ")}` : "schema up to date");
  await db.end();
}
