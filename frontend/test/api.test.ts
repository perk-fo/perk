import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { adminApi, api, ApiRequestError, addressSegment } from "@/lib/api";

const MEME = "0x00000000000000000000000000000000000000aA";
const WALLET = "0x00000000000000000000000000000000000000cc";

let requested: { url: string; method: string }[] = [];
const realFetch = globalThis.fetch;

beforeEach(() => {
  requested = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requested.push({ url: String(input), method: init?.method ?? "GET" });
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("addressSegment", () => {
  test("passes a 0x address through (any case)", () => {
    expect(addressSegment(MEME)).toBe(MEME);
    expect(addressSegment(MEME.toLowerCase())).toBe(MEME.toLowerCase());
  });

  test("refuses anything else with the API's own error code", () => {
    for (const bad of ["../operators", `${MEME}/../../x`, `${MEME}?hidden=1`, "0x123", "", "vitalik.eth"]) {
      let err: unknown;
      try {
        addressSegment(bad);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(ApiRequestError);
      expect((err as ApiRequestError).code).toBe("bad_address");
      expect((err as ApiRequestError).status).toBe(400);
    }
  });
});

describe("API paths", () => {
  test("public and admin paths carry the address as one segment", async () => {
    await api.launch(MEME);
    await api.grantProof(MEME, WALLET);
    await adminApi.removeOperator("tok", WALLET);
    await adminApi.setModeration("tok", MEME, { hidden: true, mediaHidden: true, reason: null });
    await adminApi.setQuoteDisplay("tok", MEME, {} as never);
    const paths = requested.map((r) => `${r.method} ${new URL(r.url).pathname}`);
    expect(paths).toEqual([
      `GET /v1/launches/${MEME}`,
      `GET /v1/grants/${MEME}/proof/${WALLET}`,
      `DELETE /v1/admin/operators/${WALLET}`,
      `PUT /v1/admin/moderation/${MEME}`,
      `PUT /v1/admin/quote-assets/${MEME}`,
    ]);
  });

  test("a crafted value is rejected before any request, as a rejected promise", async () => {
    await expect(adminApi.removeOperator("tok", "../moderation/0x00000000000000000000000000000000000000aa")).rejects.toThrow(
      ApiRequestError,
    );
    await expect(adminApi.setModeration("tok", `${MEME}?x=1`, { hidden: false, mediaHidden: false, reason: null })).rejects.toThrow();
    await expect(api.wallet("0xnot-an-address")).rejects.toThrow();
    expect(requested).toEqual([]);
  });
});
