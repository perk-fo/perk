import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { migrate } from "../src/db/migrate";
import { resetDb } from "./helpers";
import type { Db } from "../src/db/client";

let db: Db;

describe("migrate", () => {
  beforeAll(async () => {
    db = await resetDb();
  });
  afterAll(async () => {
    await db.end({ timeout: 5 });
  });

  test("applies every migration in order on an empty schema; second run applies nothing", async () => {
    await db.unsafe("drop schema public cascade; create schema public;");
    const first = await migrate(db);
    expect(first).toEqual([
      "0001_init.sql",
      "0002_grant_datasets.sql",
      "0003_launch_metadata.sql",
      "0004_grant_exit_meme.sql",
      "0005_lp_positions.sql",
      "0006_admin.sql",
      "0007_admin_chain_scope.sql",
      "0008_quarantined_logs.sql",
      "0009_grant_co_ownership.sql",
    ]);
    const second = await migrate(db);
    expect(second).toEqual([]);
    const rows = await db<{ version: number; name: string }[]>`select version, name from schema_migrations order by version`;
    expect(rows).toHaveLength(9);
    expect(Number(rows[0].version)).toBe(1);
    expect(rows[0].name).toBe("0001_init.sql");
    expect(Number(rows[1].version)).toBe(2);
    expect(rows[1].name).toBe("0002_grant_datasets.sql");
    expect(Number(rows[2].version)).toBe(3);
    expect(rows[2].name).toBe("0003_launch_metadata.sql");
    expect(Number(rows[3].version)).toBe(4);
    expect(rows[3].name).toBe("0004_grant_exit_meme.sql");
    expect(Number(rows[4].version)).toBe(5);
    expect(rows[4].name).toBe("0005_lp_positions.sql");
    expect(Number(rows[5].version)).toBe(6);
    expect(rows[5].name).toBe("0006_admin.sql");
    expect(rows[6].name).toBe("0007_admin_chain_scope.sql");
    expect(rows[7].name).toBe("0008_quarantined_logs.sql");
    expect(rows[8].name).toBe("0009_grant_co_ownership.sql");
  });

  test("admin rows written before chain scoping belong to the one indexed chain", async () => {
    await db.unsafe("drop schema public cascade; create schema public;");
    // the schema as the previous release left it: migrations up to 0006 only
    const source = join(import.meta.dir, "../migrations");
    mkdirSync(join(import.meta.dir, "../data"), { recursive: true });
    const dir = mkdtempSync(join(import.meta.dir, "../data/migrations-"));
    try {
      for (const f of readdirSync(source).filter((f) => f < "0007")) cpSync(join(source, f), join(dir, f));
      await migrate(db, dir);
      await db`insert into sync_state (chain_id, cursor_block, start_block) values (1952, 1, 1)`;
      await db`insert into admin_operators (address, added_by) values ('0xa', '0xb')`;
      await db`insert into admin_sessions (token_hash, address, expires_at) values ('h', '0xa', now() + interval '1 hour')`;
      await db`insert into admin_audit (address, action) values ('0xb', 'operator_add')`;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    await migrate(db);
    const ops = await db<{ chain_id: number; address: string }[]>`select chain_id, address from admin_operators`;
    expect(ops.map((r) => [r.chain_id, r.address])).toEqual([[1952, "0xa"]]);
    expect(await db`select 1 from admin_sessions`).toHaveLength(0);
    expect((await db<{ chain_id: number }[]>`select chain_id from admin_audit`)[0]!.chain_id).toBe(1952);
  });
});
