import { describe, expect, test, beforeAll, afterAll } from "bun:test";
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
    ]);
    const second = await migrate(db);
    expect(second).toEqual([]);
    const rows = await db<{ version: number; name: string }[]>`select version, name from schema_migrations order by version`;
    expect(rows).toHaveLength(5);
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
  });
});
