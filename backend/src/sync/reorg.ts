import type { Client } from "../chain/rpc";
import { getHeader } from "../chain/rpc";

/**
 * Reorg handling, correct by construction: the index is never patched. When the block the cursor points at is no
 * longer the chain's block at that height, everything derived for the chain is deleted and the index is rebuilt from
 * the deployment block (Indexer.resetChain). X Layer is a rollup with a single sequencer, so this is rare, and
 * CONFIRMATIONS keeps the indexer off the tip.
 *
 * Within a window the indexer also checks that every log's block hash is the hash of the header it fetched for that
 * block, that the window's first block sits on the cursor block and that the window's last block did not change while
 * its logs were read (indexer.ts). A mismatch there aborts the window; the next pass sees any replaced cursor here.
 */
export async function cursorIsCanonical(
  client: Client,
  cursorBlock: bigint,
  cursorHash: string | null,
): Promise<boolean> {
  if (!cursorHash) return true;
  const current = await getHeader(client, cursorBlock);
  return current.hash.toLowerCase() === cursorHash.toLowerCase();
}
