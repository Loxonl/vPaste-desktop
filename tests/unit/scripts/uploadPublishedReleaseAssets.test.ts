import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const uploadScript = "scripts/upload-published-release-assets.sh";
const tag = "v1.6.0-rc.14";

type Asset = { name: string; digest: string };
type Release = { isDraft: boolean; isImmutable: boolean; assets: Asset[]; notFound?: boolean };

function digest(contents: string) {
  return `sha256:${createHash("sha256").update(contents).digest("hex")}`;
}

function withRelease(initial: Release, files: Record<string, string>, run: (context: {
  releasePath: string;
  assetsDir: string;
  env: NodeJS.ProcessEnv;
}) => void) {
  const root = mkdtempSync(join(tmpdir(), "vpaste-release-upload-"));
  const binDir = join(root, "bin");
  const assetsDir = join(root, "assets");
  const releasePath = join(root, "release.json");
  mkdirSync(binDir);
  mkdirSync(assetsDir);
  writeFileSync(releasePath, JSON.stringify(initial));
  for (const [name, contents] of Object.entries(files)) writeFileSync(join(assetsDir, name), contents);
  writeFileSync(join(binDir, "gh"), `#!/usr/bin/env node
const fs = require("node:fs");
const crypto = require("node:crypto");
const path = require("node:path");
const args = process.argv.slice(2);
const release = JSON.parse(fs.readFileSync(process.env.TEST_RELEASE_PATH, "utf8"));
if (args[0] !== "release") process.exit(3);
if (args[2] !== process.env.TEST_TAG) process.exit(7);
if (args[1] === "view") {
  if (release.notFound) process.exit(2);
  process.stdout.write(JSON.stringify(release));
} else if (args[1] === "upload") {
  for (const file of args.slice(3)) {
    if (file.startsWith("--")) process.exit(4);
    const name = path.basename(file);
    if (release.assets.some(asset => asset.name === name)) process.exit(5);
    const digest = "sha256:" + crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    release.assets.push({ name, digest });
  }
  fs.writeFileSync(process.env.TEST_RELEASE_PATH, JSON.stringify(release));
} else {
  process.exit(6);
}
`);
  chmodSync(join(binDir, "gh"), 0o755);
  const env = { ...process.env, PATH: `${binDir}:${process.env.PATH}`, TEST_RELEASE_PATH: releasePath, TEST_TAG: tag };
  try {
    run({ releasePath, assetsDir, env });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function upload(assetsDir: string, env: NodeJS.ProcessEnv) {
  return execFileSync("bash", [uploadScript, tag, assetsDir], { env, encoding: "utf8", stdio: "pipe" });
}

describe("published release asset upload", () => {
  it("adds new packages to the existing published release", () => {
    withRelease({ isDraft: false, isImmutable: false, assets: [] }, { "setup.exe": "installer" }, ({ releasePath, assetsDir, env }) => {
      upload(assetsDir, env);
      expect(JSON.parse(readFileSync(releasePath, "utf8")).assets).toEqual([
        { name: "setup.exe", digest: digest("installer") },
      ]);
    });
  });

  it("leaves an identical existing asset untouched on rerun", () => {
    const existing = { name: "setup.exe", digest: digest("installer") };
    withRelease({ isDraft: false, isImmutable: false, assets: [existing] }, { "setup.exe": "installer" }, ({ releasePath, assetsDir, env }) => {
      upload(assetsDir, env);
      expect(JSON.parse(readFileSync(releasePath, "utf8")).assets).toEqual([existing]);
    });
  });

  it("rejects a same-name asset with different bytes", () => {
    const existing = { name: "setup.exe", digest: digest("original") };
    withRelease({ isDraft: false, isImmutable: false, assets: [existing] }, { "setup.exe": "replacement" }, ({ releasePath, assetsDir, env }) => {
      expect(() => upload(assetsDir, env)).toThrow(/different digest/);
      expect(JSON.parse(readFileSync(releasePath, "utf8")).assets).toEqual([existing]);
    });
  });

  it("rejects immutable releases before uploading", () => {
    withRelease({ isDraft: false, isImmutable: true, assets: [] }, { "setup.exe": "installer" }, ({ releasePath, assetsDir, env }) => {
      expect(() => upload(assetsDir, env)).toThrow(/immutable release/);
      expect(JSON.parse(readFileSync(releasePath, "utf8")).assets).toEqual([]);
    });
  });

  it("does not create a release when the requested tag has none", () => {
    withRelease({ isDraft: false, isImmutable: false, assets: [], notFound: true }, { "setup.exe": "installer" }, ({ releasePath, assetsDir, env }) => {
      expect(() => upload(assetsDir, env)).toThrow(/no release was created/);
      expect(JSON.parse(readFileSync(releasePath, "utf8")).assets).toEqual([]);
    });
  });

  it("does not upload to a draft release", () => {
    withRelease({ isDraft: true, isImmutable: false, assets: [] }, { "setup.exe": "installer" }, ({ releasePath, assetsDir, env }) => {
      expect(() => upload(assetsDir, env)).toThrow(/still a draft/);
      expect(JSON.parse(readFileSync(releasePath, "utf8")).assets).toEqual([]);
    });
  });
});
