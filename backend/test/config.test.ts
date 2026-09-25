import { afterEach, describe, expect, test } from "bun:test";
import { loadConfig, type AppConfig } from "../src/config";
import { TEST_DEPLOYMENT } from "./helpers";

const BASE: Partial<AppConfig> = {
  chainId: 1952,
  deployment: TEST_DEPLOYMENT,
  rpcUrl: "http://mock",
  databaseUrl: "postgres://localhost:5432/perk_test",
  mediaDriver: "local",
  pinataJwt: undefined,
};

/** Environment variables a test sets, put back afterwards (Bun loads backend/.env into tests). */
const saved = new Map<string, string | undefined>();
function setEnv(name: string, value: string | undefined): void {
  if (!saved.has(name)) saved.set(name, process.env[name]);
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  saved.clear();
});

describe("config", () => {
  test("test_loadConfig_reverts_nonsenseNumbers", () => {
    expect(() => loadConfig({ ...BASE, publicApiUrl: "http://localhost:8787", logPage: 0 })).toThrow(/LOG_PAGE/);
    setEnv("LOG_PAGE", "0");
    expect(() => loadConfig({ ...BASE, publicApiUrl: "http://localhost:8787" })).toThrow(/LOG_PAGE/);
    setEnv("LOG_PAGE", "1.5");
    expect(() => loadConfig({ ...BASE, publicApiUrl: "http://localhost:8787" })).toThrow(/LOG_PAGE/);
    setEnv("LOG_PAGE", undefined);
    expect(() => loadConfig({ ...BASE, publicApiUrl: "http://localhost:8787", port: 70_000 })).toThrow(/PORT/);
    expect(() => loadConfig({ ...BASE, publicApiUrl: "http://localhost:8787", trustedProxyHops: 11 })).toThrow(/TRUSTED_PROXY_HOPS/);
  });

  test("test_loadConfig_reverts_missingPublicApiUrlInProduction", () => {
    setEnv("PUBLIC_API_URL", undefined);
    setEnv("NODE_ENV", "production");
    expect(() => loadConfig(BASE)).toThrow(/PUBLIC_API_URL/);
    expect(loadConfig({ ...BASE, publicApiUrl: "https://api.perk.example/" }).publicApiUrl).toBe("https://api.perk.example");
    // Pinata links are ipfs:// and do not depend on it
    expect(() => loadConfig({ ...BASE, mediaDriver: "pinata", pinataJwt: "jwt" })).not.toThrow();
    setEnv("NODE_ENV", "development");
    expect(loadConfig(BASE).publicApiUrl).toMatch(/^http:\/\/localhost:/);
    // mainnet counts as production whatever NODE_ENV says
    expect(() => loadConfig({ ...BASE, chainId: 196 })).toThrow(/PUBLIC_API_URL/);
  });

  test("test_loadConfig_trustedProxyHops", () => {
    setEnv("TRUST_PROXY", undefined);
    setEnv("TRUSTED_PROXY_HOPS", undefined);
    const base = { ...BASE, publicApiUrl: "http://localhost:8787" };
    expect(loadConfig(base).trustedProxyHops).toBe(0);
    setEnv("TRUST_PROXY", "true");
    expect(loadConfig(base).trustedProxyHops).toBe(1);
    setEnv("TRUSTED_PROXY_HOPS", "2");
    expect(loadConfig(base)).toMatchObject({ trustedProxyHops: 2, trustProxy: true });
  });

  test("test_loadConfig_fileDatasetsOnlyByChoiceAndNeverOnMainnet", () => {
    setEnv("ALLOW_FILE_DATASET_URIS", undefined);
    const base = { ...BASE, publicApiUrl: "http://localhost:8787" };
    expect(loadConfig(base).allowFileDatasetUris).toBe(false);
    setEnv("ALLOW_FILE_DATASET_URIS", "true");
    expect(loadConfig(base).allowFileDatasetUris).toBe(true);
    expect(() => loadConfig({ ...base, chainId: 196 })).toThrow(/ALLOW_FILE_DATASET_URIS/);
  });
});
