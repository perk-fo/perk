/**
 * i18n consistency check (bun run scripts/check-i18n.ts):
 * 1. Every dictionary key must exist in every locale.
 * 2. No CJK characters in src/app or src/components (all UI copy lives in src/i18n/messages).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { LOCALES, MESSAGES } from "../src/i18n/locales";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let failed = false;

// ---- 1. key parity ----
const keySets = LOCALES.map((l) => ({ locale: l, keys: new Set(Object.keys(MESSAGES[l])) }));
const allKeys = new Set(keySets.flatMap(({ keys }) => [...keys]));
for (const { locale, keys } of keySets) {
  const missing = [...allKeys].filter((k) => !keys.has(k));
  if (missing.length > 0) {
    failed = true;
    console.error(`[i18n] ${locale} is missing ${missing.length} key(s):`);
    for (const k of missing.sort()) console.error(`  - ${k}`);
  }
}
if (!failed) console.log(`[i18n] key parity OK (${allKeys.size} keys × ${LOCALES.length} locales)`);

// ---- 2. no CJK in src/app or src/components ----
const CJK = /[぀-ヿ一-鿿가-힯]/;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

for (const dir of ["src/app", "src/components"]) {
  for (const file of walk(join(root, dir))) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      if (CJK.test(line)) {
        failed = true;
        console.error(`[i18n] CJK in ${relative(root, file)}:${i + 1}: ${line.trim().slice(0, 80)}`);
      }
    });
  }
}
if (!failed) console.log("[i18n] no CJK in src/app or src/components");

if (failed) {
  console.error("[i18n] check FAILED");
  process.exit(1);
}
console.log("[i18n] all checks passed");
