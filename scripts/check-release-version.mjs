import { readFileSync } from "node:fs";

const readJson = path => JSON.parse(readFileSync(path, "utf8"));
const packageJson = readJson("package.json");
const packageLock = readJson("package-lock.json");
const tauriConfig = readJson("src-tauri/tauri.conf.json");
const cargoToml = readFileSync("src-tauri/Cargo.toml", "utf8");
const cargoLock = readFileSync("src-tauri/Cargo.lock", "utf8");

const cargoPackage = cargoToml.match(/^\[package\][\s\S]*?^version\s*=\s*"([^"]+)"/m);
const lockPackage = cargoLock
  .split("[[package]]")
  .find(block => /^\s*name\s*=\s*"vpaste-desktop"\s*$/m.test(block));
const lockVersion = lockPackage?.match(/^version\s*=\s*"([^"]+)"/m);

if (!cargoPackage || !lockVersion) {
  throw new Error("Could not read the application version from Cargo files.");
}

const versions = new Map([
  ["package.json", packageJson.version],
  ["package-lock.json", packageLock.packages?.[""]?.version ?? packageLock.version],
  ["src-tauri/tauri.conf.json", tauriConfig.version],
  ["src-tauri/Cargo.toml", cargoPackage[1]],
  ["src-tauri/Cargo.lock", lockVersion[1]],
]);
const uniqueVersions = new Set(versions.values());

if (uniqueVersions.size !== 1) {
  throw new Error(`Version mismatch:\n${[...versions].map(([file, version]) => `- ${file}: ${version}`).join("\n")}`);
}

const version = [...uniqueVersions][0];
const githubTag = process.env.GITHUB_REF_TYPE === "tag" ? process.env.GITHUB_REF_NAME : undefined;
const tag = process.argv[2] ?? process.env.RELEASE_TAG ?? githubTag;
if (tag && tag !== `v${version}`) {
  throw new Error(`Release tag ${tag} does not match application version v${version}.`);
}

console.log(`Release version is consistent: v${version}${tag ? ` (${tag})` : ""}`);
