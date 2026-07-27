#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const [, , output, ...inputs] = process.argv;
if (!output || inputs.length === 0) {
  throw new Error("Usage: merge-updater-manifests.mjs <output> <manifest> [...manifest]");
}

const manifests = inputs.map(input => JSON.parse(fs.readFileSync(input, "utf8")));
const version = manifests[0].version;
if (manifests.some(manifest => manifest.version !== version)) {
  throw new Error("Updater manifest versions do not match");
}

const platforms = {};
for (const manifest of manifests) {
  for (const [platform, value] of Object.entries(manifest.platforms ?? {})) {
    if (platforms[platform]) throw new Error(`Duplicate updater platform: ${platform}`);
    platforms[platform] = value;
  }
}

const merged = {
  version,
  notes: manifests.find(manifest => manifest.notes)?.notes ?? "",
  pub_date: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  platforms,
};
fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
console.log(`Merged ${inputs.length} updater manifests into ${output}`);
