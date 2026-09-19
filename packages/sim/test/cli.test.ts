import { describe, expect, test } from "bun:test";
import { main as grantMain } from "../src/cli/grant.ts";
import { main as graduationMain } from "../src/cli/graduation.ts";

describe("cli", () => {
  test("test_cli_modulesExportMainWithoutSideEffects", () => {
    expect(typeof graduationMain).toBe("function");
    expect(typeof grantMain).toBe("function");
  });
});
