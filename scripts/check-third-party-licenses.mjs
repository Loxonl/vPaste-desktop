import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const packageLock = JSON.parse(readFileSync("package-lock.json", "utf8"));
const npmPackages = Object.entries(packageLock.packages)
  .filter(([path]) => path !== "")
  .map(([path, metadata]) => ({
    ecosystem: "npm",
    name: metadata.name ?? path.split("node_modules/").at(-1),
    version: metadata.version,
    license: metadata.license,
    developmentOnly: metadata.dev === true,
  }));

const cargo = spawnSync(
  "cargo",
  ["metadata", "--locked", "--format-version", "1", "--manifest-path", "src-tauri/Cargo.toml"],
  { encoding: "utf8", maxBuffer: 50 * 1024 * 1024 },
);
if (cargo.error) throw cargo.error;
if (cargo.status !== 0) {
  process.stderr.write(cargo.stderr ?? "cargo metadata failed.\n");
  process.exit(cargo.status ?? 1);
}

const cargoMetadata = JSON.parse(cargo.stdout);
const cargoPackages = cargoMetadata.packages
  .filter(metadata => metadata.source)
  .map(metadata => ({
    ecosystem: "cargo",
    name: metadata.name,
    version: metadata.version,
    license: metadata.license,
    developmentOnly: false,
  }));

const inventoryByPackage = new Map();
for (const item of [...npmPackages, ...cargoPackages]) {
  const key = `${item.ecosystem}:${item.name}@${item.version}`;
  const existing = inventoryByPackage.get(key);
  if (existing) {
    existing.developmentOnly = existing.developmentOnly && item.developmentOnly;
  } else {
    inventoryByPackage.set(key, { ...item });
  }
}
const inventory = [...inventoryByPackage.values()]
  .sort((left, right) => `${left.ecosystem}:${left.name}`.localeCompare(`${right.ecosystem}:${right.name}`));
const deniedLicense = /(?:^|[^A-Z])(?:AGPL|BUSL|GPL|SSPL|UNLICENSED|LicenseRef|SEE LICENSE)(?:[^A-Z]|$)/i;
const problems = inventory.filter(item => !item.license || deniedLicense.test(item.license));

if (problems.length > 0) {
  console.error("Third-party dependencies with missing or disallowed/custom licenses:");
  problems.forEach(item => console.error(`- ${item.ecosystem}:${item.name}@${item.version}: ${item.license ?? "missing"}`));
  process.exit(1);
}

const outputIndex = process.argv.indexOf("--output");
if (outputIndex !== -1) {
  const outputPath = process.argv[outputIndex + 1];
  if (!outputPath) throw new Error("--output requires a path.");
  const absolutePath = resolve(outputPath);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, `${JSON.stringify({ generatedFrom: ["package-lock.json", "src-tauri/Cargo.lock"], packages: inventory }, null, 2)}\n`);
  console.log(`Wrote dependency license inventory to ${outputPath}.`);
}

const sbomIndex = process.argv.indexOf("--sbom");
if (sbomIndex !== -1) {
  const sbomPath = process.argv[sbomIndex + 1];
  if (!sbomPath) throw new Error("--sbom requires a path.");
  const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
  const purl = item => {
    const name = encodeURIComponent(item.name).replaceAll("%2F", "/");
    return `pkg:${item.ecosystem}/${name}@${item.version}`;
  };
  const sbom = {
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    serialNumber: `urn:uuid:${randomUUID()}`,
    version: 1,
    metadata: {
      timestamp: new Date().toISOString(),
      component: {
        type: "application",
        name: packageJson.name,
        version: packageJson.version,
        licenses: [{ license: { id: packageJson.license } }],
      },
    },
    components: inventory.map(item => ({
      type: "library",
      "bom-ref": purl(item),
      group: item.name.startsWith("@") ? item.name.split("/")[0].slice(1) : undefined,
      name: item.name.startsWith("@") ? item.name.split("/")[1] : item.name,
      version: item.version,
      scope: item.developmentOnly ? "excluded" : "required",
      licenses: [{ license: { name: item.license } }],
      purl: purl(item),
    })),
  };
  const absolutePath = resolve(sbomPath);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, `${JSON.stringify(sbom, null, 2)}\n`);
  console.log(`Wrote CycloneDX SBOM to ${sbomPath}.`);
}

console.log(`Checked ${npmPackages.length} npm packages and ${cargoPackages.length} Cargo packages.`);
