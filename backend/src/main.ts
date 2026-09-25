import { loadConfig, loadDotenv } from "./config";
import { createDb } from "./db/client";
import { migrate } from "./db/migrate";
import { createClient } from "./chain/rpc";
import { Indexer } from "./sync/indexer";
import { acquireIndexerLock, type IndexerLock } from "./sync/lock";
import { createApp } from "./api/server";
import { createWsHub } from "./api/ws";
import { runDatasetLoader } from "./grants/datasets";
import { createMediaStore } from "./media/store";
import { runMetadataResolver } from "./media/resolver";
import { allowAddressRanges } from "./net/fetchPublic";
import { setImageProxyBase } from "./media/ipfsImages";
import { PriceService } from "./prices/service";
import { errorText, log } from "./log";

/**
 * Entry point. `bun run src/main.ts [--sync-only | --serve-only]`.
 * Boot order: load .env → config → migrate → (indexer lock → init → runForever) ∥ (HTTP server).
 * Logs are single-line JSON to stdout, with the RPC URL and other secrets removed (log.ts).
 */
async function main(): Promise<void> {
  loadDotenv();
  const cfg = loadConfig();
  const args = new Set(process.argv.slice(2));
  const db = createDb(cfg.databaseUrl);
  const ran = await migrate(db);
  log("boot", { chainId: cfg.chainId, migrations: ran, port: cfg.port, confirmations: cfg.confirmations });

  const tasks: Promise<unknown>[] = [];
  let indexer: Indexer | null = null;
  let lock: IndexerLock | null = null;
  let stopping = false;
  if (!args.has("--serve-only")) {
    // One indexer per chain: a second process waits for the lock (and keeps serving the API meanwhile) until the
    // first one exits.
    tasks.push(
      (async () => {
        lock = await acquireIndexerLock(cfg.databaseUrl, cfg.chainId, { log, shouldStop: () => stopping });
        if (!lock || stopping) return;
        indexer = new Indexer({ db, client: createClient(cfg.rpcUrl), config: cfg, log, lock });
        await indexer.init();
        await indexer.runForever();
      })(),
    );
  }
  let hub: ReturnType<typeof createWsHub> | null = null;
  if (!args.has("--sync-only")) {
    const media = createMediaStore(cfg);
    const client = createClient(cfg.rpcUrl);
    // quote-asset USD prices, refreshed in the background; GET /v1/prices only reads what it kept
    const prices = new PriceService({ db, chainId: cfg.chainId, sources: cfg.priceSources, log });
    const app = createApp({ db, config: cfg, media, client, prices });
    hub = createWsHub({ db, config: cfg });
    const server = Bun.serve({
      port: cfg.port,
      // Media uploads are the only POSTs; without this Bun would buffer a body of up to its 128 MiB default before
      // any route sees it, so an oversize chunked upload could be used to exhaust memory.
      maxRequestBodySize: cfg.maxBodyBytes,
      fetch: (req, srv) => {
        const u = hub!.upgrade(req, srv);
        if (u === true) return undefined;
        if (u) return u;
        return app.fetch(req, { ip: srv.requestIP(req)?.address });
      },
      websocket: hub.websocket,
    });
    await hub.start(server);
    log("listening", { url: `http://localhost:${server.port}` });
    tasks.push(
      runDatasetLoader({
        db,
        chainId: cfg.chainId,
        log,
        ipfsGateway: cfg.ipfsGateway,
        allowFileUris: cfg.allowFileDatasetUris,
      }),
    );
    allowAddressRanges(cfg.fetchAllowRanges);
    setImageProxyBase(cfg.publicApiUrl);
    tasks.push(runMetadataResolver({ db, config: cfg, media, log }));
    tasks.push(prices.run());
    tasks.push(new Promise(() => {}));
  }

  const shutdown = async (signal: string) => {
    log("shutdown", { signal });
    stopping = true;
    indexer?.stop();
    await hub?.stop();
    await lock?.release();
    await db.end({ timeout: 5 });
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  await Promise.all(tasks);
}

export { log };

if (import.meta.main) {
  main().catch((err) => {
    console.error(errorText(err));
    process.exit(1);
  });
}
