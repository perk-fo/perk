import { describe, expect, test } from "bun:test";
import {
  isLogRangeError,
  isPermanentRpcError,
  logRangeHint,
  redactSecrets,
  redactUrl,
  resolveRpcUrl,
  rpcSettingsFromEnv,
  withRetry,
} from "../src/rpc";

const KEY = "AbCdEf0123456789_secretKey";
const ALCHEMY = `https://xlayer-testnet.g.alchemy.com/v2/${KEY}`;

describe("redaction", () => {
  test("a URL is cut down to scheme and host", () => {
    expect(redactUrl(ALCHEMY)).toBe("https://xlayer-testnet.g.alchemy.com/<redacted>");
    expect(redactUrl("https://user:pw@rpc.example.com")).toBe("https://rpc.example.com/<redacted>");
    expect(redactUrl("https://rpc.example.com/?apikey=1234567")).toBe("https://rpc.example.com/<redacted>");
    expect(redactUrl("https://testrpc.xlayer.tech")).toBe("https://testrpc.xlayer.tech");
    expect(redactUrl("not a url")).toBe("<redacted>");
  });

  test("error text loses the endpoint, the key on its own, and any other URL's path", () => {
    const viemLike = `HTTP request failed.\n\nURL: ${ALCHEMY}\nRequest body: {"method":"eth_getLogs"}\nDetails: key ${KEY} is rate limited`;
    const out = redactSecrets(viemLike, [ALCHEMY, KEY]);
    expect(out).not.toContain(KEY);
    expect(out).toContain("https://xlayer-testnet.g.alchemy.com/<redacted>");
    expect(out).toContain("eth_getLogs");
    expect(redactSecrets("see https://other.example/v2/abcdefgh for details")).toBe(
      "see https://other.example/<redacted> for details",
    );
  });

  test("the key is hidden even when printed as a bare path", () => {
    expect(redactSecrets(`GET /v2/${KEY} failed`, [ALCHEMY])).not.toContain(KEY);
  });
});

describe("resolveRpcUrl", () => {
  test("RPC_URL wins over ALCHEMY_API_KEY", () => {
    expect(resolveRpcUrl(1952, { env: { RPC_URL: "https://testrpc.xlayer.tech", ALCHEMY_API_KEY: KEY } })).toEqual({
      url: "https://testrpc.xlayer.tech",
      source: "RPC_URL",
    });
  });

  test("the Alchemy endpoint is built per chain from the key", () => {
    expect(resolveRpcUrl(1952, { env: { ALCHEMY_API_KEY: KEY } })?.url).toBe(ALCHEMY);
    expect(resolveRpcUrl(196, { env: { ALCHEMY_API_KEY: KEY } })?.url).toBe(
      `https://xlayer-mainnet.g.alchemy.com/v2/${KEY}`,
    );
  });

  test("the flag still works but is reported as such", () => {
    expect(resolveRpcUrl(1952, { flagUrl: "https://a.example", env: { RPC_URL: "https://b.example" } })?.source).toBe(
      "--rpc-url",
    );
  });

  test("nothing configured → null", () => {
    expect(resolveRpcUrl(1952, { env: {} })).toBeNull();
  });
});

describe("rpcSettingsFromEnv", () => {
  test("defaults suit the public X Layer endpoint's batch limit", () => {
    const s = rpcSettingsFromEnv({});
    expect(s.batchSize).toBe(10);
    expect(s.logPage).toBe(1000n);
    expect(s.concurrency).toBeGreaterThan(0);
  });

  test("reads every variable", () => {
    const s = rpcSettingsFromEnv({
      RPC_BATCH_SIZE: "1",
      RPC_CONCURRENCY: "3",
      RPC_RETRIES: "0",
      RPC_RETRY_DELAY_MS: "10",
      RPC_TIMEOUT_MS: "5000",
      LOG_PAGE: "100",
      LOG_CONCURRENCY: "2",
    });
    expect(s).toEqual({
      batchSize: 1,
      concurrency: 3,
      retries: 0,
      retryDelayMs: 10,
      timeoutMs: 5000,
      logPage: 100n,
      logConcurrency: 2,
    });
  });

  test("LOG_PAGE=0 and other nonsense fail loudly", () => {
    expect(() => rpcSettingsFromEnv({ LOG_PAGE: "0" })).toThrow(/LOG_PAGE/);
    expect(() => rpcSettingsFromEnv({ RPC_BATCH_SIZE: "ten" })).toThrow(/RPC_BATCH_SIZE/);
    expect(() => rpcSettingsFromEnv({ RPC_CONCURRENCY: "-1" })).toThrow();
  });
});

describe("error classification", () => {
  test("the X Layer range error is a range error with a hint", () => {
    const err = Object.assign(new Error("block range greater than 100 max"), { code: -32602 });
    expect(isLogRangeError(err)).toBe(true);
    expect(logRangeHint(err)).toBe(100n);
    expect(isPermanentRpcError(err)).toBe(true);
  });

  test("a range error nested as a cause is still recognised", () => {
    const err = new Error("RPC Request failed.", { cause: new Error("block range greater than 100 max") });
    expect(isLogRangeError(err)).toBe(true);
  });

  test("timeouts and rate limits are transient; reverts and oversized batches are not", () => {
    expect(isPermanentRpcError(new Error("The request took too long to respond."))).toBe(false);
    expect(isPermanentRpcError(Object.assign(new Error("rate limited"), { code: 429 }))).toBe(false);
    expect(isPermanentRpcError(new Error("execution reverted"))).toBe(true);
    expect(isPermanentRpcError(Object.assign(new Error("too many RPC calls in batch request"), { code: -32014 }))).toBe(true);
  });
});

describe("withRetry", () => {
  test("retries transient failures with growing delays, then succeeds", async () => {
    const delays: number[] = [];
    let calls = 0;
    const out = await withRetry(
      async () => {
        if (++calls < 4) throw new Error("socket hang up");
        return "ok";
      },
      { retries: 5, retryDelayMs: 100, sleep: async (ms) => void delays.push(ms) },
    );
    expect(out).toBe("ok");
    expect(calls).toBe(4);
    expect(delays.length).toBe(3);
    // exponential with jitter in [50%, 100%] of 100, 200, 400
    expect(delays[0]).toBeGreaterThanOrEqual(50);
    expect(delays[2]).toBeGreaterThanOrEqual(200);
    expect(delays[2]).toBeLessThanOrEqual(400);
  });

  test("gives up after the retry budget", async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new Error("503");
        },
        { retries: 2, retryDelayMs: 1, sleep: async () => {} },
      ),
    ).rejects.toThrow("503");
    expect(calls).toBe(3);
  });

  test("does not retry permanent failures", async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new Error("execution reverted");
        },
        { retries: 5, retryDelayMs: 1, sleep: async () => {} },
      ),
    ).rejects.toThrow();
    expect(calls).toBe(1);
  });
});
