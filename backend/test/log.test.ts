import { describe, expect, spyOn, test } from "bun:test";
import { HttpRequestError, TimeoutError } from "viem";
import { log, publicErrorText, publicText, redact, registerSecret } from "../src/log";

const RPC_URL = "https://xlayer-testnet.g.alchemy.com/v2/k3yK3yK3yK3yK3yK3yK3yK3yK3yK3y00";
const KEY = "k3yK3yK3yK3yK3yK3yK3yK3yK3yK3y00";

describe("error text that leaves the process", () => {
  registerSecret(RPC_URL);

  test("test_redact_removesTheRpcUrlAndItsKey", () => {
    expect(redact(`request to ${RPC_URL} failed`)).not.toContain(KEY);
    expect(redact(`key ${KEY} in some other form`)).not.toContain(KEY);
    expect(redact("postgres://perk:hunter22@db:5432/perk")).not.toContain("hunter22");
    expect(redact("https://rpc.example/?apikey=abcdef123456&x=1")).not.toContain("abcdef123456");
    expect(redact("Authorization: Bearer eyJhbGciOi.abc.def")).not.toContain("eyJhbGciOi");
  });

  test("test_publicErrorText_keepsClassAndStatusButNoUrl", () => {
    const err = new HttpRequestError({ url: RPC_URL, status: 503, body: { method: "eth_blockNumber" }, details: "upstream down" });
    expect(err.message).toContain(KEY); // what viem would otherwise have published
    const text = publicErrorText(err);
    expect(text).toContain("HttpRequestError");
    expect(text).toContain("HTTP 503");
    expect(text).not.toContain(KEY);
    expect(text).not.toContain("alchemy.com");
    expect(text).not.toContain("\n");

    const timeout = publicErrorText(new TimeoutError({ body: {}, url: RPC_URL }));
    expect(timeout).not.toContain(KEY);
    expect(timeout).not.toContain("alchemy.com");

    // an unregistered URL is still removed from public text
    expect(publicErrorText(new Error("fetch https://other.example/v3/abc failed"))).not.toContain("other.example");
    expect(publicText("stored before: URL: https://x.example/v2/secret")).not.toContain("secret");
    // what is stored must itself be storable
    expect(publicErrorText(new Error("bad name Evil\u0000 \ud800"))).toBe("Error: bad name Evil \ufffd");
  });

  test("test_log_neverWritesTheRpcKey", () => {
    const spy = spyOn(console, "log").mockImplementation(() => {});
    try {
      log("indexer error", { err: new HttpRequestError({ url: RPC_URL, status: 429, body: {} }), note: `at ${RPC_URL}` });
      const line = String(spy.mock.calls[0]?.[0]);
      expect(line).toContain("indexer error");
      expect(line).not.toContain(KEY);
    } finally {
      spy.mockRestore();
    }
  });
});
