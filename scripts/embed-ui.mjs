#!/usr/bin/env node
/**
 * Regenerate `src/core/uiEmbedded.ts` from the built launchpad assets so
 * standalone binaries can serve `boot ui` without files on disk.
 *
 * Usage:  node scripts/embed-ui.mjs           # embed ui/.output/public
 *         node scripts/embed-ui.mjs --reset   # restore the empty stub
 *
 * `scripts/build-release.sh` runs this before compiling and resets after,
 * so the checked-in file stays a stub.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = path.join(root, "src", "core", "uiEmbedded.ts");
const publicDir = path.join(root, "ui", ".output", "public");

const HEADER = `/**
 * Embedded \`boot ui\` assets, keyed by request path (e.g. "/index.html") with
 * base64-encoded contents.
 *
 * This file is a stub in source. Release builds regenerate it from the built
 * Nuxt app via \`scripts/embed-ui.mjs\` (see \`scripts/build-release.sh\`) so the
 * standalone binary can serve the UI without files on disk. In a source
 * checkout, \`boot ui\` serves \`ui/.output/public\` from disk instead.
 */
`;

if (process.argv.includes("--reset")) {
  writeFileSync(target, `${HEADER}export const embeddedUiAssets: Record<string, string> = {};\n`);
  console.log("reset src/core/uiEmbedded.ts to the empty stub");
  process.exit(0);
}

function collect(dir, prefix = "") {
  const assets = {};
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const key = `${prefix}/${entry}`;
    if (statSync(full).isDirectory()) Object.assign(assets, collect(full, key));
    else assets[key] = readFileSync(full).toString("base64");
  }
  return assets;
}

let assets;
try {
  assets = collect(publicDir);
} catch {
  console.error("ui/.output/public not found. Build the UI first: pnpm ui:build");
  process.exit(1);
}

const entries = Object.entries(assets)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([key, value]) => `  ${JSON.stringify(key)}:\n    ${JSON.stringify(value)},`)
  .join("\n");
writeFileSync(
  target,
  `${HEADER}// prettier-ignore\nexport const embeddedUiAssets: Record<string, string> = {\n${entries}\n};\n`,
);
const total = Object.values(assets).reduce((sum, value) => sum + value.length, 0);
console.log(
  `embedded ${Object.keys(assets).length} ui assets (${(total / 1024).toFixed(0)} KiB base64) into src/core/uiEmbedded.ts`,
);
