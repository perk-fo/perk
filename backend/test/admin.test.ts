import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { encodeAbiParameters, toFunctionSelector, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import type { Db, Tx } from "../src/db/client";
import { createApp } from "../src/api/server";
import { TokenBucketLimiter } from "../src/media/rateLimit";
import type {
  AdminAuditEntry,
  AdminLaunch,
  AdminMe,
  AdminNonce,
  AdminOperator,
  AdminSession,
  GrantCampaign,
  LaunchDetail,
  LaunchSummary,
  QuoteAsset,
  WalletRoles,
} from "../src/api/types";
import { decodePerkLog, perkContracts, type PerkContract } from "../src/chain/events";
import { applyLog, type ApplyContext } from "../src/sync/apply";
import { INDEX_VERSION, resetIndex } from "../src/sync/state";
import { TrackedSet } from "../src/sync/tracked";
import { Indexer } from "../src/sync/indexer";
import { issueNonce } from "../src/admin/auth";
import { selectRoleHolders } from "../src/admin/roles";
import { MAX_FEATURED } from "../src/api/routes/admin";
import { ADMIN, CHAIN, MEME_CURVE, MEME_GRAD, START_BLOCK, WOKB, ZERO, resetDb, seed, testConfig } from "./api-helpers";
import { ABI_BY_CONTRACT, TEST_DEPLOYMENT as D, blockHash, makeLog, mockClient, type MockLog } from "./helpers";

const SITE = "http://localhost:3000";
const OTHER_SITE = "https://perk.example";

let db: Db;
let app: ReturnType<typeof createApp>;
let core: PrivateKeyAccount;
let grant: PrivateKeyAccount;
let operator: PrivateKeyAccount;
let stranger: PrivateKeyAccount;

/** What the contracts answer for owner() (factory) and publisher() (grant vault). */
const onChain: { core: Address; grant: Address } = { core: ZERO, grant: ZERO };
let rpcDown = false;
const OWNER = toFunctionSelector("owner()");
const PUBLISHER = toFunctionSelector("publisher()");

/** The chain as the API reads it: the role getters answer from `onChain`; any other call has no code behind it. */
const roleClient = mockClient((method, params) => {
  if (rpcDown) throw new Error("rpc down");
  if (method !== "eth_call") throw new Error(`unexpected ${method}`);
  const call = (params[0] ?? {}) as { to?: string; data?: string };
  const to = (call.to ?? "").toLowerCase();
  const selector = (call.data ?? "").slice(0, 10);
  if (to === D.factory.toLowerCase() && selector === OWNER) return encodeAbiParameters([{ type: "address" }], [onChain.core]);
  if (to === D.lpGrantVault.toLowerCase() && selector === PUBLISHER) return encodeAbiParameters([{ type: "address" }], [onChain.grant]);
  return "0x";
});

/** Make `account` hold an on-chain role: on the chain, and in the index the way the indexer would record it. */
async function holdChainRole(role: "core" | "grant", account: Address, block: number) {
  onChain[role] = account;
  await db`insert into chain_role_events (chain_id, role, address, block_number, log_index)
    values (${CHAIN}, ${role}, ${account.toLowerCase()}, ${block}, 0)`;
}

function adminApp(overrides: Partial<Parameters<typeof testConfig>[0]> = {}) {
  return createApp({
    db,
    config: testConfig({ corsOrigins: [SITE, OTHER_SITE], ...overrides }),
    authLimiter: new TokenBucketLimiter(10_000, 60_000),
    client: roleClient,
    roleCacheMs: 0,
  });
}

function call(
  method: string,
  path: string,
  opts: { body?: unknown; token?: string; origin?: string | null } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.origin !== null) headers.origin = opts.origin ?? SITE;
  return Promise.resolve(
    app.request(path, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) }),
  );
}

async function ok<T>(res: Response | Promise<Response>, status = 200): Promise<T> {
  const r = await res;
  const body = await r.json();
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(body)}`);
  return body as T;
}

async function errorOf(res: Response | Promise<Response>): Promise<{ status: number; error: string }> {
  const r = await res;
  const body = (await r.json()) as { error: string };
  return { status: r.status, error: body.error };
}

async function nonceFor(account: PrivateKeyAccount, origin = SITE): Promise<string> {
  return (await ok<AdminNonce>(call("POST", "/v1/admin/auth/nonce", { body: { address: account.address }, origin }))).message;
}

async function signIn(account: PrivateKeyAccount): Promise<string> {
  const message = await nonceFor(account);
  const signature = await account.signMessage({ message });
  return (await ok<AdminSession>(call("POST", "/v1/admin/auth/login", { body: { message, signature } }))).token;
}

beforeAll(async () => {
  db = await resetDb();
  await seed(db);
  onChain.core = ADMIN;
  app = adminApp();
  core = privateKeyToAccount(generatePrivateKey());
  grant = privateKeyToAccount(generatePrivateKey());
  operator = privateKeyToAccount(generatePrivateKey());
  stranger = privateKeyToAccount(generatePrivateKey());
  // ownership moved from the seeded owner to `core`; `grant` was appointed publisher
  await holdChainRole("core", core.address, START_BLOCK + 10);
  await holdChainRole("grant", grant.address, START_BLOCK + 11);
  await db`insert into admin_operators (chain_id, address, added_by)
    values (${CHAIN}, ${operator.address.toLowerCase()}, ${core.address.toLowerCase()})`;
});

afterAll(async () => {
  await db.end({ timeout: 5 });
});

// ---------------------------------------------------------------- roles come from the chain

describe("chain roles", () => {
  function perkMap() {
    const m = new Map<string, { name: PerkContract; abi: readonly unknown[] }>();
    for (const c of perkContracts(D)) m.set(c.address.toLowerCase(), { name: c.name, abi: c.abi });
    return m;
  }
  const ctx: ApplyContext = {
    chainId: 77,
    deployment: D,
    client: mockClient(() => {
      throw new Error("no rpc");
    }),
    tracked: new TrackedSet(),
    blockTime: new Map(),
    txOrigin: new Map(),
    quoteDecimals: new Map(),
  };
  async function apply(log: MockLog) {
    ctx.blockTime.set(log.blockNumber, 1_700_000_000n + log.blockNumber);
    const decoded = decodePerkLog(
      {
        address: log.address,
        blockNumber: log.blockNumber,
        blockHash: blockHash(log.blockNumber),
        transactionHash: log.transactionHash,
        logIndex: log.logIndex,
        topics: log.topics as [Hex, ...Hex[]],
        data: log.data,
      },
      perkMap(),
    );
    if (!decoded) throw new Error("decode failed");
    await db.begin(async (tx) => applyLog(tx as unknown as Tx, ctx, decoded));
  }
  const A = "0x00000000000000000000000000000000000000aa" as Address;
  const B = "0x00000000000000000000000000000000000000bb" as Address;
  const P = "0x00000000000000000000000000000000000000cc" as Address;

  test("test_roles_followOwnershipAndPublisherEvents", async () => {
    await apply(makeLog({ address: D.factory, abi: ABI_BY_CONTRACT.factory, eventName: "OwnershipTransferred", args: { previousOwner: ZERO, newOwner: A }, blockNumber: 10n }));
    await apply(makeLog({ address: D.lpGrantVault, abi: ABI_BY_CONTRACT.lpGrantVault, eventName: "PublisherUpdated", args: { previous: ZERO, current: P }, blockNumber: 11n }));
    expect(await selectRoleHolders(db, 77)).toEqual({ core: A.toLowerCase(), grant: P.toLowerCase() });

    await apply(makeLog({ address: D.factory, abi: ABI_BY_CONTRACT.factory, eventName: "OwnershipTransferred", args: { previousOwner: A, newOwner: B }, blockNumber: 20n, logIndex: 3 }));
    await apply(makeLog({ address: D.lpGrantVault, abi: ABI_BY_CONTRACT.lpGrantVault, eventName: "PublisherUpdated", args: { previous: P, current: ZERO }, blockNumber: 20n, logIndex: 4 }));
    // the publisher was revoked: the role is vacant, not held by the zero address
    expect(await selectRoleHolders(db, 77)).toEqual({ core: B.toLowerCase(), grant: null });
  });

  test("test_roles_ignoreOwnershipOfOtherContracts", async () => {
    // the vault is Ownable too, but only the factory's owner is the Core Admin
    await apply(makeLog({ address: D.lpGrantVault, abi: ABI_BY_CONTRACT.lpGrantVault, eventName: "OwnershipTransferred", args: { previousOwner: B, newOwner: P }, blockNumber: 30n }));
    expect((await selectRoleHolders(db, 77)).core).toBe(B.toLowerCase());
  });

  test("test_templateRegistered_takesStatusFromStruct", async () => {
    const template = {
      hookVersion: 1,
      moduleBitmap: 7n,
      totalFeeBps: 100,
      feeSplit: { devBps: 5000, rewardsBps: 2500, lpBps: 1500, treasuryBps: 500, protocolBps: 500 },
      supply: { totalSupply: 10n, curveSupply: 6n, poolReserveSupply: 4n, grantReserveSupply: 0n },
      curve: { virtualQuoteReserve: 30n, virtualMemeReserve: 900n, graduationQuoteThreshold: 85n },
      pool: { lpFee: 1500, tickSpacing: 60, tickLower: -887220, tickUpper: 887220, leftoverPolicy: 0 },
      grant: { enabled: false, reserveBps: 0, baseGrantPoolBps: 0, referralBudgetBps: 0, windowSeconds: 0n, minLpSeconds: 0n, referralBoostEnabled: false },
      minEligibleBalance: 1n,
      status: 2,
      anyQuote: false,
      quote: WOKB,
    };
    const id = `0x${"ab".repeat(32)}` as Hex;
    await apply(makeLog({ address: D.templateRegistry, abi: ABI_BY_CONTRACT.templateRegistry, eventName: "TemplateRegistered", args: { templateId: id, template }, blockNumber: 40n }));
    const [row] = await db<{ status: number }[]>`select status from templates where chain_id = 77 and template_id = ${id}`;
    expect(Number(row!.status)).toBe(2);
    await db`delete from templates where chain_id = 77`;
  });
});

// ---------------------------------------------------------------- rebuilding the index keeps admin decisions

describe("index rebuild", () => {
  test("test_resetIndex_keepsAdminDecisionsAndOtherChains", async () => {
    await db`insert into launch_moderation (chain_id, meme, hidden, updated_by) values (999, '0x1', true, 'x')`;
    await db`insert into chain_role_events (chain_id, role, address, block_number, log_index) values (999, 'core', '0x1', 1, 0)`;
    await db`insert into sync_state (chain_id, cursor_block, start_block) values (999, 5, 1)`;
    const launchesBefore = (await db`select 1 from launches where chain_id = ${CHAIN}`).length;
    const cleared = await resetIndex(db, 999);
    expect(cleared).toContain("launches");
    expect(cleared).toContain("chain_role_events");
    expect(cleared).toContain("sync_state");
    expect(cleared).not.toContain("admin_operators");
    expect(cleared).not.toContain("launch_moderation");
    expect((await db`select 1 from admin_operators`).length).toBe(1);
    expect((await db`select 1 from launch_moderation where chain_id = 999`).length).toBe(1);
    expect((await db`select 1 from chain_role_events where chain_id = 999`).length).toBe(0);
    expect((await db`select 1 from sync_state where chain_id = 999`).length).toBe(0);
    // the other chain in the same database keeps its index
    expect((await db`select 1 from chain_role_events where chain_id = ${CHAIN}`).length).toBeGreaterThan(0);
    expect((await db`select 1 from launches where chain_id = ${CHAIN}`).length).toBe(launchesBefore);
    expect((await db`select 1 from sync_state where chain_id = ${CHAIN}`).length).toBe(1);
    // put the fixture back for the API tests below
    await db`delete from launch_moderation where chain_id = 999`;
    await reseed();
  });

  test("test_indexerInit_rebuildsOlderIndexVersion", async () => {
    await db`update sync_state set index_version = ${INDEX_VERSION - 1} where chain_id = ${CHAIN}`;
    const indexer = new Indexer({
      db,
      client: mockClient(() => {
        throw new Error("no rpc during init");
      }),
      config: testConfig({ deployment: { ...D, blockNumber: START_BLOCK } }),
    });
    await indexer.init();
    const [state] = await db<{ index_version: number; cursor_block: string }[]>`
      select index_version, cursor_block from sync_state where chain_id = ${CHAIN}`;
    expect(Number(state!.index_version)).toBe(INDEX_VERSION);
    expect(BigInt(state!.cursor_block)).toBe(BigInt(START_BLOCK) - 1n);
    expect((await db`select 1 from launches`).length).toBe(0);
    expect((await db`select 1 from admin_operators`).length).toBe(1);
    await reseed();
  });
});

async function reseed() {
  const keepOps = await db`select * from admin_operators`;
  await db.unsafe(`truncate table ${(
    await db<{ table_name: string }[]>`select table_name from information_schema.tables
      where table_schema = current_schema() and table_type = 'BASE TABLE' and table_name <> 'schema_migrations'`
  )
    .map((r) => `"${r.table_name}"`)
    .join(", ")} restart identity cascade`);
  await seed(db);
  await holdChainRole("core", core.address, START_BLOCK + 10);
  await holdChainRole("grant", grant.address, START_BLOCK + 11);
  for (const o of keepOps) await db`insert into admin_operators ${db(o as never)}`;
}

// ---------------------------------------------------------------- sign-in

describe("sign-in", () => {
  test("test_login_opensSessionForAnAdmin", async () => {
    const message = await nonceFor(core);
    expect(message).toContain("localhost:3000 wants you to sign in with your Ethereum account:");
    expect(message).toContain(core.address);
    expect(message).toContain("Chain ID: 1952");
    const signature = await core.signMessage({ message });
    const session = await ok<AdminSession>(call("POST", "/v1/admin/auth/login", { body: { message, signature } }));
    expect(session.token).toMatch(/^[0-9a-f]{64}$/);
    expect(session.roles).toEqual(["core"]);
    const me = await ok<AdminMe>(call("GET", "/v1/admin/me", { token: session.token }));
    expect(me.address).toBe(core.address.toLowerCase() as Address);
    expect(me.roles).toEqual(["core"]);
    // only a hash of the token is stored
    const rows = await db<{ token_hash: string }[]>`select token_hash from admin_sessions`;
    expect(rows.some((r) => r.token_hash === session.token)).toBe(false);
  });

  test("test_nonce_reverts_unknownOrigin", async () => {
    expect(await errorOf(call("POST", "/v1/admin/auth/nonce", { body: { address: core.address }, origin: "https://evil.example" }))).toEqual({ status: 403, error: "bad_origin" });
    expect(await errorOf(call("POST", "/v1/admin/auth/nonce", { body: { address: core.address }, origin: null }))).toEqual({ status: 403, error: "bad_origin" });
  });

  test("test_login_reverts_nonceReused", async () => {
    const message = await nonceFor(core);
    const signature = await core.signMessage({ message });
    await ok(call("POST", "/v1/admin/auth/login", { body: { message, signature } }));
    expect(await errorOf(call("POST", "/v1/admin/auth/login", { body: { message, signature } }))).toEqual({ status: 401, error: "nonce_unknown" });
  });

  test("test_login_reverts_otherSigner", async () => {
    const message = await nonceFor(core);
    const forged = await stranger.signMessage({ message });
    expect(await errorOf(call("POST", "/v1/admin/auth/login", { body: { message, signature: forged } }))).toEqual({ status: 401, error: "bad_signature" });
    // the failed attempt used the nonce up
    const signature = await core.signMessage({ message });
    expect(await errorOf(call("POST", "/v1/admin/auth/login", { body: { message, signature } }))).toEqual({ status: 401, error: "nonce_unknown" });
  });

  test("test_nonce_isRandomAndCannotBeBurnedByOthers", async () => {
    const nonceOf = (m: string) => /Nonce: (\S+)/.exec(m)![1]!;
    const first = nonceOf(await nonceFor(stranger));
    const message = await nonceFor(core);
    const second = nonceOf(message);
    expect(second).toMatch(/^[0-9a-f]{32}$/);
    // no shared run between consecutive nonces (a sliding window would share all but one character)
    expect(second.slice(0, 8)).not.toBe(first.slice(1, 9));
    expect(second).not.toBe(first);

    // someone who knows the pending nonce but not the exact message cannot use it up
    const forged = message.replace(/Issued At: .*/, "Issued At: 2026-01-01T00:00:00.000Z");
    expect(forged).not.toBe(message);
    expect(await errorOf(call("POST", "/v1/admin/auth/login", { body: { message: forged, signature: await stranger.signMessage({ message: forged }) } }))).toEqual({
      status: 401,
      error: "bad_message",
    });
    const signature = await core.signMessage({ message });
    await ok(call("POST", "/v1/admin/auth/login", { body: { message, signature } }));
  });

  test("test_login_reverts_nulInMessage", async () => {
    expect((await errorOf(call("POST", "/v1/admin/auth/login", { body: { message: "a\u0000b", signature: "0x00" } }))).status).toBe(400);
  });

  test("test_login_reverts_editedMessage", async () => {
    const message = await nonceFor(core);
    const edited = message.replace("Sign in to the Perk admin.", "Sign in to the Perk admin!");
    const signature = await core.signMessage({ message: edited });
    expect(await errorOf(call("POST", "/v1/admin/auth/login", { body: { message: edited, signature } }))).toEqual({ status: 401, error: "bad_message" });
  });

  test("test_login_reverts_otherSite", async () => {
    // a message issued for one site cannot be used to sign in on another
    const message = await nonceFor(core, SITE);
    const signature = await core.signMessage({ message });
    expect(await errorOf(call("POST", "/v1/admin/auth/login", { body: { message, signature }, origin: OTHER_SITE }))).toEqual({ status: 401, error: "bad_message" });
  });

  test("test_login_reverts_expiredNonce", async () => {
    const { message } = await issueNonce(db, { address: core.address, chainId: CHAIN, origin: SITE, now: new Date(Date.now() - 11 * 60_000) });
    const signature = await core.signMessage({ message });
    expect(await errorOf(call("POST", "/v1/admin/auth/login", { body: { message, signature } }))).toEqual({ status: 401, error: "nonce_expired" });
  });

  test("test_login_reverts_noAdminRole", async () => {
    const message = await nonceFor(stranger);
    const signature = await stranger.signMessage({ message });
    expect(await errorOf(call("POST", "/v1/admin/auth/login", { body: { message, signature } }))).toEqual({ status: 403, error: "not_admin" });
    expect((await db`select 1 from admin_sessions where address = ${stranger.address.toLowerCase()}`).length).toBe(0);
  });

  test("test_login_reverts_malformedBody", async () => {
    expect((await errorOf(call("POST", "/v1/admin/auth/login", { body: { message: 5, signature: "0x" } }))).status).toBe(400);
    expect((await errorOf(call("POST", "/v1/admin/auth/login", { body: { message: "hello", signature: "zz" } }))).status).toBe(400);
    expect((await errorOf(call("POST", "/v1/admin/auth/login", { body: { message: "hello", signature: "0x1234" } }))).error).toBe("bad_message");
  });

  test("test_session_expiresAndLogsOut", async () => {
    const token = await signIn(core);
    await ok(call("GET", "/v1/admin/me", { token }));
    await ok(call("POST", "/v1/admin/auth/logout", { token }));
    expect((await errorOf(call("GET", "/v1/admin/me", { token }))).status).toBe(401);

    const token2 = await signIn(core);
    await db`update admin_sessions set expires_at = now() - interval '1 second'`;
    expect((await errorOf(call("GET", "/v1/admin/me", { token: token2 }))).status).toBe(401);
    expect((await errorOf(call("GET", "/v1/admin/me", { token: "not-a-token" }))).status).toBe(401);
    expect((await errorOf(call("GET", "/v1/admin/me"))).status).toBe(401);
  });

  test("test_nonce_reverts_rateLimited", async () => {
    const strict = createApp({ db, config: testConfig({ corsOrigins: [SITE] }), authLimiter: new TokenBucketLimiter(2, 600_000), client: roleClient });
    const post = () =>
      strict.request("/v1/admin/auth/nonce", {
        method: "POST",
        headers: { origin: SITE, "content-type": "application/json" },
        body: JSON.stringify({ address: core.address }),
      });
    expect((await post()).status).toBe(200);
    expect((await post()).status).toBe(200);
    expect((await post()).status).toBe(429);
  });

  test("test_cors_allowsAdminMethods", async () => {
    const res = await app.request("/v1/admin/moderation/0x0000000000000000000000000000000000000c01", {
      method: "OPTIONS",
      headers: { origin: SITE, "access-control-request-method": "PUT", "access-control-request-headers": "authorization,content-type" },
    });
    expect(res.headers.get("access-control-allow-origin")).toBe(SITE);
    expect(res.headers.get("access-control-allow-methods")).toContain("PUT");
    expect(res.headers.get("access-control-allow-methods")).toContain("DELETE");
    const pub = await app.request("/v1/launches", {
      method: "OPTIONS",
      headers: { origin: SITE, "access-control-request-method": "PUT" },
    });
    expect(pub.headers.get("access-control-allow-methods")).not.toContain("PUT");
  });
});

// ---------------------------------------------------------------- what each role may do

describe("role boundaries", () => {
  let coreToken: string;
  let grantToken: string;
  let opToken: string;
  beforeAll(async () => {
    coreToken = await signIn(core);
    grantToken = await signIn(grant);
    opToken = await signIn(operator);
  });

  test("test_me_reportsEachRole", async () => {
    expect((await ok<AdminMe>(call("GET", "/v1/admin/me", { token: grantToken }))).roles).toEqual(["grant"]);
    expect((await ok<AdminMe>(call("GET", "/v1/admin/me", { token: opToken }))).roles).toEqual(["operator"]);
    const roles = await ok<WalletRoles>(call("GET", `/v1/wallets/${operator.address.toLowerCase()}/roles`));
    expect(roles.adminRoles).toEqual(["operator"]);
    expect(roles.isAdmin).toBe(true);
    // the seeded owner handed ownership to `core`, so it is no longer an admin
    expect((await ok<WalletRoles>(call("GET", `/v1/wallets/${ADMIN}/roles`))).adminRoles).toEqual([]);
  });

  test("test_operators_reverts_notCore", async () => {
    expect((await errorOf(call("GET", "/v1/admin/operators", { token: opToken }))).status).toBe(403);
    expect((await errorOf(call("POST", "/v1/admin/operators", { token: opToken, body: { address: stranger.address } }))).status).toBe(403);
    expect((await errorOf(call("POST", "/v1/admin/operators", { token: grantToken, body: { address: stranger.address } }))).status).toBe(403);
    expect((await errorOf(call("GET", "/v1/admin/audit", { token: opToken }))).status).toBe(403);
    expect((await errorOf(call("POST", "/v1/admin/operators", { body: { address: stranger.address } }))).status).toBe(401);
  });

  test("test_curation_reverts_grantAdmin", async () => {
    expect((await errorOf(call("GET", "/v1/admin/moderation", { token: grantToken }))).status).toBe(403);
    expect((await errorOf(call("PUT", `/v1/admin/moderation/${MEME_CURVE}`, { token: grantToken, body: { hidden: true, mediaHidden: true, reason: null } }))).status).toBe(403);
    expect((await errorOf(call("PUT", "/v1/admin/featured", { token: grantToken, body: { memes: [] } }))).status).toBe(403);
    expect((await errorOf(call("PUT", `/v1/admin/quote-assets/${WOKB}`, { token: grantToken, body: { listed: false } }))).status).toBe(403);
  });

  test("test_operators_coreAddsAndRemoves", async () => {
    const added = await ok<{ operators: AdminOperator[] }>(call("POST", "/v1/admin/operators", { token: coreToken, body: { address: stranger.address } }));
    expect(added.operators.map((o) => o.address)).toContain(stranger.address.toLowerCase() as Address);
    const strangerToken = await signIn(stranger);
    await ok(call("GET", "/v1/admin/moderation", { token: strangerToken }));

    await ok(call("DELETE", `/v1/admin/operators/${stranger.address}`, { token: coreToken }));
    // removal ends their sessions at once
    expect((await errorOf(call("GET", "/v1/admin/moderation", { token: strangerToken }))).status).toBe(401);

    const audit = await ok<{ entries: AdminAuditEntry[] }>(call("GET", "/v1/admin/audit", { token: coreToken }));
    const actions = audit.entries.map((e) => `${e.action}:${e.target ?? ""}`);
    expect(actions).toContain(`operator_add:${stranger.address.toLowerCase()}`);
    expect(actions).toContain(`operator_remove:${stranger.address.toLowerCase()}`);
  });

  test("test_roles_followOwnershipTransfer", async () => {
    // ownership moves on: the old Core Admin's session keeps working as a session, but carries no role
    const next = privateKeyToAccount(generatePrivateKey());
    await holdChainRole("core", next.address, START_BLOCK + 50);
    expect(await errorOf(call("GET", "/v1/admin/operators", { token: coreToken }))).toEqual({ status: 403, error: "forbidden" });
    await db`delete from chain_role_events where block_number = ${START_BLOCK + 50}`;
    onChain.core = core.address;
    await ok(call("GET", "/v1/admin/operators", { token: coreToken }));
  });

  test("test_roles_comeFromTheChainNotTheLaggingIndex", async () => {
    // The index still names a former owner (it lags, or is being rebuilt and has replayed only old blocks); the chain
    // has moved on. The former owner signs in as nobody and cannot appoint General Admins.
    const former = privateKeyToAccount(generatePrivateKey());
    await db`insert into chain_role_events (chain_id, role, address, block_number, log_index)
      values (${CHAIN}, 'core', ${former.address.toLowerCase()}, ${START_BLOCK + 60}, 0)`;
    try {
      const message = await nonceFor(former);
      const signature = await former.signMessage({ message });
      expect(await errorOf(call("POST", "/v1/admin/auth/login", { body: { message, signature } }))).toEqual({ status: 403, error: "not_admin" });
      // and the current owner keeps the role although the index says otherwise
      expect((await ok<AdminMe>(call("GET", "/v1/admin/me", { token: coreToken }))).roles).toEqual(["core"]);
    } finally {
      await db`delete from chain_role_events where block_number = ${START_BLOCK + 60}`;
    }
  });

  test("test_admin_reverts_rolesUnreadable", async () => {
    // fail closed: without an answer from the chain nobody gets an on-chain role
    rpcDown = true;
    try {
      expect(await errorOf(call("GET", "/v1/admin/me", { token: coreToken }))).toEqual({ status: 503, error: "roles_unavailable" });
      const message = await nonceFor(core);
      const signature = await core.signMessage({ message });
      expect(await errorOf(call("POST", "/v1/admin/auth/login", { body: { message, signature } }))).toEqual({ status: 503, error: "roles_unavailable" });
      // the public role view falls back to the index rather than failing
      const roles = await ok<WalletRoles>(call("GET", `/v1/wallets/${core.address.toLowerCase()}/roles`));
      expect(roles.adminRoles).toEqual(["core"]);
    } finally {
      rpcDown = false;
    }
  });

  test("test_operators_belongToOneChain", async () => {
    // the same database behind an API for another chain: this chain's General Admins and sessions mean nothing there
    const other = adminApp({ chainId: 77 });
    const res = await other.request("/v1/admin/me", { headers: { authorization: `Bearer ${opToken}`, origin: SITE } });
    expect(res.status).toBe(401);
    const message = (await ok<AdminNonce>(
      other.request("/v1/admin/auth/nonce", { method: "POST", headers: { origin: SITE, "content-type": "application/json" }, body: JSON.stringify({ address: operator.address }) }),
    )).message;
    const signature = await operator.signMessage({ message });
    const login = await other.request("/v1/admin/auth/login", {
      method: "POST",
      headers: { origin: SITE, "content-type": "application/json" },
      body: JSON.stringify({ message, signature }),
    });
    expect(login.status).toBe(403);
    expect((await ok<{ operators: AdminOperator[] }>(call("GET", "/v1/admin/operators", { token: coreToken }))).operators.map((o) => o.address)).toContain(
      operator.address.toLowerCase() as Address,
    );
  });
});

// ---------------------------------------------------------------- moderation

describe("moderation", () => {
  let token: string;
  beforeAll(async () => {
    token = await signIn(operator);
    await db`update launches set metadata = ${db.json({ image: "https://img.example/a.png", description: "hi", links: {} } as never)},
      metadata_status = 'ok' where chain_id = ${CHAIN}`;
  });
  beforeEach(async () => {
    await db`delete from launch_moderation`;
  });

  test("test_moderation_hiddenLeavesListsButNotItsPage", async () => {
    const before = await ok<{ launches: LaunchSummary[]; total: number }>(call("GET", "/v1/launches"));
    const updated = await ok<AdminLaunch>(
      call("PUT", `/v1/admin/moderation/${MEME_CURVE}`, { token, body: { hidden: true, mediaHidden: false, reason: "impersonates a brand" } }),
    );
    expect(updated.hidden).toBe(true);
    expect(updated.mediaHidden).toBe(true); // hiding always withholds media too
    expect(updated.metadata?.image).toBe("https://img.example/a.png"); // admins still see it

    const after = await ok<{ launches: LaunchSummary[]; total: number }>(call("GET", "/v1/launches"));
    expect(after.total).toBe(before.total - 1);
    expect(after.launches.map((l) => l.meme)).not.toContain(MEME_CURVE);

    const detail = await ok<LaunchDetail>(call("GET", `/v1/launches/${MEME_CURVE}`));
    expect(detail.moderation).toEqual({ hidden: true, mediaHidden: true });
    expect(detail.metadata).toBeNull();
    // the reason is for admins only
    expect(JSON.stringify(detail)).not.toContain("impersonates");

    const list = await ok<{ launches: AdminLaunch[] }>(call("GET", "/v1/admin/moderation", { token }));
    expect(list.launches.map((l) => [l.launch.meme, l.reason])).toEqual([[MEME_CURVE, "impersonates a brand"]]);
    const search = await ok<{ launches: AdminLaunch[] }>(call("GET", `/v1/admin/launches?q=${MEME_CURVE.slice(0, 12)}`, { token }));
    expect(search.launches.map((l) => l.launch.meme)).toContain(MEME_CURVE);
  });

  test("test_moderation_mediaHiddenStaysListed", async () => {
    await ok(call("PUT", `/v1/admin/moderation/${MEME_GRAD}`, { token, body: { hidden: false, mediaHidden: true, reason: null } }));
    const list = await ok<{ launches: LaunchSummary[] }>(call("GET", "/v1/launches"));
    const grad = list.launches.find((l) => l.meme === MEME_GRAD)!;
    expect(grad.metadata).toBeNull();
    expect(grad.moderation).toEqual({ hidden: false, mediaHidden: true });
    const curve = list.launches.find((l) => l.meme === MEME_CURVE)!;
    expect(curve.metadata?.image).toBe("https://img.example/a.png");
    expect(curve.moderation).toBeNull();
  });

  test("test_moderation_hiddenLaunchLeavesGrantList", async () => {
    await ok(call("PUT", `/v1/admin/moderation/${MEME_GRAD}`, { token, body: { hidden: true, mediaHidden: true, reason: null } }));
    const pub = await ok<{ campaigns: GrantCampaign[] }>(call("GET", "/v1/grants"));
    expect(pub.campaigns.map((c) => c.meme)).not.toContain(MEME_GRAD);
    const all = await ok<{ campaigns: GrantCampaign[] }>(call("GET", "/v1/grants?include=hidden"));
    expect(all.campaigns.map((c) => c.meme)).toContain(MEME_GRAD);
  });

  test("test_moderation_clearingRemovesTheRow", async () => {
    await ok(call("PUT", `/v1/admin/moderation/${MEME_CURVE}`, { token, body: { hidden: true, mediaHidden: true, reason: "x" } }));
    await ok(call("PUT", `/v1/admin/moderation/${MEME_CURVE}`, { token, body: { hidden: false, mediaHidden: false, reason: null } }));
    expect((await db`select 1 from launch_moderation`).length).toBe(0);
    expect((await ok<LaunchDetail>(call("GET", `/v1/launches/${MEME_CURVE}`))).moderation).toBeNull();
  });

  test("test_moderation_reverts_badInput", async () => {
    expect((await errorOf(call("PUT", `/v1/admin/moderation/0x0000000000000000000000000000000000009999`, { token, body: { hidden: true, mediaHidden: true, reason: null } }))).status).toBe(404);
    expect((await errorOf(call("PUT", `/v1/admin/moderation/${MEME_CURVE}`, { token, body: { hidden: "yes", mediaHidden: true } }))).status).toBe(400);
    expect((await errorOf(call("PUT", `/v1/admin/moderation/${MEME_CURVE}`, { token, body: { hidden: true, mediaHidden: true, reason: "x".repeat(201) } }))).status).toBe(400);
    expect((await errorOf(call("PUT", `/v1/admin/moderation/${MEME_CURVE}`, { token, body: { hidden: true, mediaHidden: true, reason: "a\u0000b" } }))).status).toBe(400);
    expect((await errorOf(call("PUT", `/v1/admin/moderation/not-an-address`, { token, body: { hidden: true, mediaHidden: true } }))).status).toBe(400);
  });

  test("test_search_escapesWildcards", async () => {
    const res = await ok<{ launches: AdminLaunch[] }>(call("GET", `/v1/admin/launches?q=${encodeURIComponent("%")}`, { token }));
    expect(res.launches).toEqual([]);
  });
});

// ---------------------------------------------------------------- featured

describe("featured", () => {
  let token: string;
  beforeAll(async () => {
    token = await signIn(core);
    await db`delete from launch_moderation`;
  });

  test("test_featured_keepsOrderAndSkipsHidden", async () => {
    await ok(call("PUT", "/v1/admin/featured", { token, body: { memes: [MEME_GRAD, MEME_CURVE] } }));
    const pub = await ok<{ launches: LaunchSummary[] }>(call("GET", "/v1/launches/featured"));
    expect(pub.launches.map((l) => l.meme)).toEqual([MEME_GRAD, MEME_CURVE]);

    await ok(call("PUT", `/v1/admin/moderation/${MEME_GRAD}`, { token, body: { hidden: true, mediaHidden: true, reason: null } }));
    expect((await ok<{ launches: LaunchSummary[] }>(call("GET", "/v1/launches/featured"))).launches.map((l) => l.meme)).toEqual([MEME_CURVE]);
    const admin = await ok<{ launches: AdminLaunch[] }>(call("GET", "/v1/admin/featured", { token }));
    expect(admin.launches.map((l) => [l.launch.meme, l.hidden, l.featuredPosition])).toEqual([
      [MEME_GRAD, true, 1],
      [MEME_CURVE, false, 2],
    ]);
    await db`delete from launch_moderation`;
  });

  test("test_featured_reverts_badLists", async () => {
    expect((await errorOf(call("PUT", "/v1/admin/featured", { token, body: { memes: [MEME_GRAD, MEME_GRAD] } }))).status).toBe(400);
    expect((await errorOf(call("PUT", "/v1/admin/featured", { token, body: { memes: ["0x0000000000000000000000000000000000009999"] } }))).status).toBe(404);
    const many = Array.from({ length: MAX_FEATURED + 1 }, (_, i) => `0x${(i + 1).toString(16).padStart(40, "0")}`);
    expect((await errorOf(call("PUT", "/v1/admin/featured", { token, body: { memes: many } }))).status).toBe(400);
    expect((await errorOf(call("PUT", "/v1/admin/featured", { token, body: { memes: "x" } }))).status).toBe(400);
    // a rejected list leaves the old one in place
    expect((await ok<{ launches: LaunchSummary[] }>(call("GET", "/v1/launches/featured"))).launches).toHaveLength(2);
  });

  test("test_featured_emptyListClears", async () => {
    await ok(call("PUT", "/v1/admin/featured", { token, body: { memes: [] } }));
    expect((await ok<{ launches: LaunchSummary[] }>(call("GET", "/v1/launches/featured"))).launches).toEqual([]);
  });
});

// ---------------------------------------------------------------- quote currencies

describe("quote assets", () => {
  let token: string;
  beforeAll(async () => {
    token = await signIn(operator);
    const t = (quote: string, status: number, anyQuote = false) => ({ status, anyQuote, quote });
    await db`insert into templates (chain_id, template_id, status, template) values
      (${CHAIN}, '0x01', 2, ${db.json(t(WOKB, 2) as never)}),
      (${CHAIN}, '0x02', 0, ${db.json(t(WOKB, 0) as never)}),
      (${CHAIN}, '0x03', 2, ${db.json(t(ZERO, 2, true) as never)}),
      (${CHAIN}, '0x04', 2, ${db.json(t(`${WOKB.slice(0, -2)}Bb`, 2) as never)})`;
  });

  test("test_quoteAssets_defaultsAndActiveTemplates", async () => {
    const { assets } = await ok<{ assets: QuoteAsset[] }>(call("GET", "/v1/quote-assets"));
    const wokb = assets.find((a) => a.address === WOKB)!;
    // one bound active template plus a second one stored with a checksummed quote; drafts and anyQuote don't count
    expect(wokb.activeTemplates).toBe(2);
    expect(wokb.display).toEqual({ displayName: null, iconUrl: null, category: null, notice: {}, sortOrder: 0, listed: true, updatedAt: null });
    expect(assets.find((a) => a.address === ZERO)!.isNative).toBe(true);
  });

  test("test_quoteDisplay_updatesPublicView", async () => {
    const body = {
      displayName: "Wrapped OKB",
      iconUrl: "ipfs://bafyicon",
      category: "stablecoin",
      notice: { en: "Read this first.", ja: "" },
      sortOrder: -5,
      listed: false,
    };
    const updated = await ok<QuoteAsset>(call("PUT", `/v1/admin/quote-assets/${WOKB}`, { token, body }));
    expect(updated.display.iconUrl).toBe("https://ipfs.io/ipfs/bafyicon");
    const { assets } = await ok<{ assets: QuoteAsset[] }>(call("GET", "/v1/quote-assets"));
    expect(assets[0]!.address).toBe(WOKB); // sortOrder -5 puts it first
    expect(assets[0]!.display).toMatchObject({ displayName: "Wrapped OKB", category: "stablecoin", notice: { en: "Read this first." }, sortOrder: -5, listed: false });
  });

  test("test_quoteDisplay_reverts_badInput", async () => {
    const put = (body: unknown, quote: string = WOKB) => errorOf(call("PUT", `/v1/admin/quote-assets/${quote}`, { token, body }));
    expect((await put({ category: "meme" })).status).toBe(400);
    expect((await put({ iconUrl: "http://plain.example/icon.png" })).status).toBe(400);
    expect((await put({ iconUrl: "javascript:alert(1)" })).status).toBe(400);
    // this API's own uploads are fine at its own address, even over plain http in development
    const own = `${testConfig().publicApiUrl}/v1/media/ab.png`;
    expect(own.startsWith("http://")).toBe(true);
    expect((await ok<QuoteAsset>(call("PUT", `/v1/admin/quote-assets/${WOKB}`, { token, body: { iconUrl: own } }))).display.iconUrl).toBe(own);
    expect((await put({ iconUrl: `${testConfig().publicApiUrl}/elsewhere.png` })).status).toBe(400);
    expect((await put({ notice: { fr: "bonjour" } })).status).toBe(400);
    expect((await put({ sortOrder: 1.5 })).status).toBe(400);
    expect((await put({ displayName: "x".repeat(41) })).status).toBe(400);
    expect((await put({}, "0x0000000000000000000000000000000000009999")).status).toBe(404);
  });
});
