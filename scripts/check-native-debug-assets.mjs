import { readFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";

const [mode, directory = "dist"] = process.argv.slice(2);
if (!["native-debug", "production"].includes(mode)) {
  throw new Error("Use: node scripts/check-native-debug-assets.mjs <native-debug|production> [dist]");
}
const assets = join(resolve(directory), "assets");
const files = readdirSync(assets).filter(file => file.endsWith(".js"));
const embedded = mode === "native-debug";
for (const name of ["TestRoom", "DeveloperMemoryWindow"]) {
  if (files.some(file => file.startsWith(`${name}-`)) !== embedded) {
    throw new Error(`${name} must be ${embedded ? "included in native Debug" : "excluded from production"}.`);
  }
}
if (files.some(file => /^(UiLab|SettingsPreview)-/.test(file))) {
  throw new Error("UI Lab and settings previews must remain Vite-only.");
}
const content = files.map(file => readFileSync(join(assets, file), "utf8")).join("\n");
for (const route of ["/__test-room", "/__dev-memory"]) {
  if (content.includes(route) !== embedded) throw new Error(`Unexpected route inclusion: ${route}`);
}
console.log(`Native Debug asset isolation passed (${mode}).`);
