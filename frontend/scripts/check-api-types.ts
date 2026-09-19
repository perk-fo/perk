/** Fails when frontend/src/lib/api-types.ts drifted from backend/src/api/types.ts (first line is the mirror banner). */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const web = readFileSync(join(root, "src/lib/api-types.ts"), "utf8").split("\n").slice(1).join("\n");
const api = readFileSync(join(root, "../backend/src/api/types.ts"), "utf8");
if (web.trim() !== api.trim()) {
  console.error("[api-types] frontend/src/lib/api-types.ts differs from backend/src/api/types.ts — re-copy it.");
  process.exit(1);
}
console.log("[api-types] in sync");
