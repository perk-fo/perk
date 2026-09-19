import { describe, expect, test } from "bun:test";
import { addActivity, patchActivity, pruneActivity, type TxActivity } from "@/lib/tx-activity";

const a = (id: number, phase: TxActivity["phase"], updatedAt = 0): TxActivity => ({
  id, label: { key: "tx.fn.optIn" }, phase, startedAt: 0, updatedAt,
});

describe("tx activity reducers", () => {
  test("add keeps the newest N", () => {
    let l: TxActivity[] = [];
    for (let i = 1; i <= 7; i++) l = addActivity(l, a(i, "preparing"), 5);
    expect(l.map((x) => x.id)).toEqual([3, 4, 5, 6, 7]);
  });
  test("patch updates one entry and stamps the time", () => {
    const l = patchActivity([a(1, "signing"), a(2, "signing")], 2, { phase: "confirming", hash: "0xab" }, 99);
    expect(l[0].phase).toBe("signing");
    expect(l[1]).toMatchObject({ phase: "confirming", hash: "0xab", updatedAt: 99 });
  });
  test("finished entries expire, in-flight ones never do", () => {
    const l = [a(1, "success", 0), a(2, "error", 0), a(3, "confirming", 0)];
    expect(pruneActivity(l, 6000).map((x) => x.id)).toEqual([2, 3]);
    expect(pruneActivity(l, 10_000).map((x) => x.id)).toEqual([3]);
  });
});
