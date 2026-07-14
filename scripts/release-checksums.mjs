import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";

const [, , command, ...args] = process.argv;

const walk = directory => readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
  const path = join(directory, entry.name);
  return entry.isDirectory() ? walk(path) : [path];
});

if (command === "generate") {
  const [bundleRoot, outputPath, target] = args;
  if (!bundleRoot || !outputPath || !target) {
    throw new Error("Usage: release-checksums.mjs generate <bundle-root> <output-file> <target-triple>");
  }
  const root = resolve(bundleRoot);
  const tauriConfig = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"));
  const platform = target.includes("apple-darwin") ? "darwin" : target.includes("windows") ? "windows" : null;
  const arch = target.split("-")[0];
  if (!platform || !arch) throw new Error(`Unsupported release target: ${target}`);
  const releaseFiles = walk(root).filter(path => (
    /[\\/]bundle[\\/]/.test(path)
    && /(?:-setup\.exe|\.exe\.sig|\.dmg|\.app\.tar\.gz|\.app\.tar\.gz\.sig)$/.test(path)
  ));
  if (releaseFiles.length === 0) throw new Error(`No release bundles found under ${bundleRoot}.`);
  const lines = releaseFiles.sort().map(path => {
    const hash = createHash("sha256").update(readFileSync(path)).digest("hex");
    const originalName = basename(path);
    const extension = [".app.tar.gz.sig", ".app.tar.gz", ".exe.sig", ".exe", ".dmg"]
      .find(candidate => originalName.endsWith(candidate));
    if (!extension) throw new Error(`Unsupported release artifact: ${originalName}`);
    const setup = extension.startsWith(".exe") ? "-setup" : "";
    const releaseName = `${tauriConfig.productName}_${tauriConfig.version}_${platform}_${arch}${setup}${extension}`;
    return `${hash}  ${releaseName}`;
  });
  mkdirSync(dirname(resolve(outputPath)), { recursive: true });
  writeFileSync(outputPath, `${lines.join("\n")}\n`);
  console.log(`Wrote ${lines.length} checksums to ${outputPath}.`);
} else if (command === "merge") {
  const [inputRoot, outputPath] = args;
  if (!inputRoot || !outputPath) throw new Error("Usage: release-checksums.mjs merge <input-root> <output-file>");
  const root = resolve(inputRoot);
  const fragments = walk(root).filter(path => statSync(path).isFile() && path.endsWith(".sha256"));
  if (fragments.length === 0) throw new Error(`No checksum fragments found under ${inputRoot}.`);
  const lines = [...new Set(fragments.flatMap(path => readFileSync(path, "utf8").trim().split(/\r?\n/)))].sort((a, b) => {
    const left = a.split(/\s{2}/)[1] ?? relative(root, a);
    const right = b.split(/\s{2}/)[1] ?? relative(root, b);
    return left.localeCompare(right);
  });
  writeFileSync(outputPath, `${lines.join("\n")}\n`);
  console.log(`Merged ${fragments.length} checksum fragments into ${outputPath}.`);
} else {
  throw new Error("Expected command: generate or merge.");
}
