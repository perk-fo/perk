import { describe, expect, test } from "bun:test";
import { LAG_CRITICAL, LAG_NOTICE, LAG_SERIOUS, lagTone, showsLag } from "../src/components/SyncStatus";

describe("indexer lag banding", () => {
  test("escalates amber -> ember -> rose as the lag grows", () => {
    expect(lagTone(0)).toBe("verdigris");
    expect(lagTone(2)).toBe("verdigris");
    expect(lagTone(LAG_NOTICE - 1)).toBe("verdigris");
    expect(lagTone(LAG_NOTICE)).toBe("amber");
    expect(lagTone(LAG_SERIOUS - 1)).toBe("amber");
    expect(lagTone(LAG_SERIOUS)).toBe("ember");
    expect(lagTone(LAG_CRITICAL - 1)).toBe("ember");
    expect(lagTone(LAG_CRITICAL)).toBe("rose");
    expect(lagTone(250_000)).toBe("rose");
  });

  test("a healthy lag is hidden from regular users and always shown to admins", () => {
    // the normal state: the indexer trails the head by its confirmations and nobody needs telling
    expect(showsLag(2, false)).toBe(false);
    expect(showsLag(2, true)).toBe(true);
    expect(showsLag(LAG_NOTICE - 1, false)).toBe(false);
    expect(showsLag(LAG_NOTICE - 1, true)).toBe(true);
  });

  test("once past the notice band both audiences see it", () => {
    for (const lag of [LAG_NOTICE, LAG_SERIOUS, LAG_CRITICAL, 99_999]) {
      expect(showsLag(lag, false)).toBe(true);
      expect(showsLag(lag, true)).toBe(true);
    }
  });
});
