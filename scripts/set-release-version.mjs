import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const args = process.argv.slice(2);
const version = args[0];
const rootOption = args.indexOf("--root");
const root = resolve(rootOption >= 0 ? args[rootOption + 1] ?? "" : ".");

if (!version || !/^\d+\.\d+\.\d+(?:-rc\.\d+)?$/.test(version)) {
  throw new Error(`Unsupported release version: ${version ?? "<missing>"}`);
}
if (rootOption >= 0 && !args[rootOption + 1]) {
  throw new Error("Missing value for --root.");
}

const read = relativePath => readFileSync(resolve(root, relativePath), "utf8");
const write = (relativePath, contents) => writeFileSync(resolve(root, relativePath), contents);
const replaceVersion = (contents, pattern, label) => {
  if (!pattern.test(contents)) throw new Error(`Could not find the application version in ${label}.`);
  return contents.replace(pattern, (_match, prefix, _currentVersion, suffix) => `${prefix}${version}${suffix}`);
};

const packageJson = JSON.parse(read("package.json"));
const packageLock = JSON.parse(read("package-lock.json"));
const tauriConfig = JSON.parse(read("src-tauri/tauri.conf.json"));
const cargoToml = read("src-tauri/Cargo.toml");
const cargoLock = read("src-tauri/Cargo.lock");
const cargoVersionPattern = /(^\[package\][\s\S]*?^version\s*=\s*")([^"]+)("$)/m;
const lockVersionPattern =
  /(^\[\[package\]\]\r?\nname\s*=\s*"vpaste-desktop"\r?\nversion\s*=\s*")([^"]+)("$)/m;
const cargoVersion = cargoToml.match(cargoVersionPattern)?.[2];
const lockVersion = cargoLock.match(lockVersionPattern)?.[2];

if (!packageLock.packages?.[""]) {
  throw new Error("Could not find the root package in package-lock.json.");
}
if (!cargoVersion || !lockVersion) {
  throw new Error("Could not read the application version from Cargo files.");
}

const currentVersions = new Map([
  ["package.json", packageJson.version],
  ["package-lock.json", packageLock.version],
  ["package-lock.json root package", packageLock.packages[""].version],
  ["src-tauri/tauri.conf.json", tauriConfig.version],
  ["src-tauri/Cargo.toml", cargoVersion],
  ["src-tauri/Cargo.lock", lockVersion],
]);
if (new Set(currentVersions.values()).size !== 1) {
  throw new Error(
    `Version mismatch before release preparation:\n${[...currentVersions]
      .map(([file, currentVersion]) => `- ${file}: ${currentVersion}`)
      .join("\n")}`,
  );
}

packageJson.version = version;
packageLock.version = version;
packageLock.packages[""].version = version;
tauriConfig.version = version;

const updatedCargoToml = replaceVersion(cargoToml, cargoVersionPattern, "src-tauri/Cargo.toml");
const updatedCargoLock = replaceVersion(cargoLock, lockVersionPattern, "src-tauri/Cargo.lock");

write("package.json", `${JSON.stringify(packageJson, null, 2)}\n`);
write("package-lock.json", `${JSON.stringify(packageLock, null, 2)}\n`);
write("src-tauri/tauri.conf.json", `${JSON.stringify(tauriConfig, null, 2)}\n`);
write("src-tauri/Cargo.toml", updatedCargoToml);
write("src-tauri/Cargo.lock", updatedCargoLock);

console.log(`Set application release version to ${version}.`);
