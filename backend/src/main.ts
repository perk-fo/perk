import { loadConfig, loadDotenv } from "./config";
import { createDb } from "./db/client";
import { migrate } from "./db/migrate";
import { createClient } from "./chain/rpc";
import { Indexer } from "./sync/indexer";
import { createApp } from "./api/server";
import { createWsHub } from "./api/ws";
import { runDatasetLoader } from "./grants/datasets";
import { createMediaStore } from "./media/store";
import { runMetadataResolver } from "./media/resolver";

/**
 * Entry point. `bun run src/main.ts [--sync-only | --serve-only]`.
 * Boot order: load .env → config → migrate → (indexer.init + runForever) ∥ (HTTP server).
 * Logs are single-line JSON to stdout; the RPC URL is never logged.
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
  if (!args.has("--serve-only")) {
    indexer = new Indexer({ db, client: createClient(cfg.rpcUrl), config: cfg, log });
    await indexer.init();
    tasks.push(indexer.runForever());
  }
  let hub: ReturnType<typeof createWsHub> | null = null;
  if (!args.has("--sync-only")) {
    const media = createMediaStore(cfg);
    const app = createApp({ db, config: cfg, media, client: createClient(cfg.rpcUrl) });
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
    tasks.push(runDatasetLoader({ db, chainId: cfg.chainId, log }));
    tasks.push(runMetadataResolver({ db, config: cfg, media, log }));
    tasks.push(new Promise(() => {}));
  }

  const shutdown = async (signal: string) => {
    log("shutdown", { signal });
    indexer?.stop();
    await hub?.stop();
    await db.end({ timeout: 5 });
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  await Promise.all(tasks);
}

export function log(msg: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...fields }, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
