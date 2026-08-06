#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

function readArgs(values) {
  const args = new Map();
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (!key?.startsWith("--") || !value) {
      throw new Error(`Invalid argument near ${key ?? "end of command"}`);
    }
    args.set(key.slice(2), value);
  }
  return args;
}

function required(args, key) {
  const value = args.get(key);
  if (!value) throw new Error(`Missing required argument --${key}`);
  return value;
}

function parseJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function decodePathSegment(segment, label) {
  try {
    return decodeURIComponent(segment);
  } catch (error) {
    throw new Error(`Invalid URL encoding in ${label}: ${error.message}`);
  }
}

function validateReleaseAssetUrl(value, tag, platform) {
  if (typeof value !== "string") {
    throw new Error(`Platform ${platform} URL must be a string`);
  }

  let url;
  try {
    url = new URL(value);
  } catch (error) {
    throw new Error(`Platform ${platform} URL is invalid: ${error.message}`);
  }

  if (url.protocol !== "https:" || url.hostname !== "github.com") {
    throw new Error(`Platform ${platform} URL must use https://github.com`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(`Platform ${platform} URL must not include credentials, query, or fragment`);
  }

  const segments = url.pathname.split("/").map((segment, index) => decodePathSegment(segment, `platform ${platform} path segment ${index}`));
  if (segments.some(segment => segment === "." || segment === "..")) {
    throw new Error(`Platform ${platform} URL must not contain dot-segment path traversal`);
  }

  const expectedPrefix = ["", "Loxonl", "vPaste-desktop", "releases", "download", tag];
  const expectedLength = expectedPrefix.length + 1;
  if (segments.length !== expectedLength || expectedPrefix.some((segment, index) => segments[index] !== segment)) {
    throw new Error(`Platform ${platform} URL must be under https://github.com/Loxonl/vPaste-desktop/releases/download/${tag}/`);
  }

  const assetName = segments.at(-1);
  if (!assetName || assetName.includes("/") || assetName === "." || assetName === "..") {
    throw new Error(`Platform ${platform} URL has an invalid asset basename`);
  }
  return assetName;
}

const args = readArgs(process.argv.slice(2));
const manifestPath = required(args, "manifest");
const version = required(args, "version");
const tag = required(args, "tag");
const expectedPlatforms = required(args, "platforms").split(",").map(value => value.trim()).filter(Boolean);
const releaseAssetsDir = args.get("release-assets-dir");
const verifyReleaseAssets = args.get("verify-release-assets");

if (!fs.existsSync(manifestPath)) throw new Error(`Updater manifest not found: ${manifestPath}`);
if (!tag.startsWith("v")) throw new Error(`Release tag must start with v: ${tag}`);
if (expectedPlatforms.length === 0) throw new Error("At least one expected platform is required");
if (releaseAssetsDir && !fs.existsSync(releaseAssetsDir)) throw new Error(`Release assets directory not found: ${releaseAssetsDir}`);

const manifest = parseJsonFile(manifestPath);
assertObject(manifest, "Updater manifest");
if (manifest.version !== version) {
  throw new Error(`Manifest version ${manifest.version ?? "<missing>"} does not match ${version}`);
}
assertObject(manifest.platforms, "Updater manifest platforms");

const actualPlatforms = Object.keys(manifest.platforms).sort();
const expectedSorted = [...expectedPlatforms].sort();
if (JSON.stringify(actualPlatforms) !== JSON.stringify(expectedSorted)) {
  throw new Error(`Manifest platforms ${actualPlatforms.join(",")} do not match expected ${expectedSorted.join(",")}`);
}

const referencedAssets = [];
for (const platform of expectedPlatforms) {
  const entry = manifest.platforms[platform];
  assertObject(entry, `Platform ${platform}`);
  if (typeof entry.signature !== "string" || entry.signature.trim() === "") {
    throw new Error(`Platform ${platform} has an empty signature`);
  }
  referencedAssets.push(validateReleaseAssetUrl(entry.url, tag, platform));
}

if (releaseAssetsDir) {
  for (const assetName of referencedAssets) {
    const assetPath = path.join(releaseAssetsDir, assetName);
    if (!fs.existsSync(assetPath) || !fs.statSync(assetPath).isFile()) {
      throw new Error(`Staged release assets are missing updater asset ${assetName}`);
    }
  }
}

if (verifyReleaseAssets) {
  const output = execFileSync(
    "gh",
    ["release", "view", tag, "--repo", verifyReleaseAssets, "--json", "assets", "--jq", ".assets[].name"],
    { encoding: "utf8" },
  );
  const releaseAssets = new Set(output.split(/\r?\n/).map(value => value.trim()).filter(Boolean));
  for (const assetName of referencedAssets) {
    if (!releaseAssets.has(assetName)) {
      throw new Error(`Release ${verifyReleaseAssets}@${tag} is missing updater asset ${assetName}`);
    }
  }
}

console.log(`Validated updater manifest ${manifestPath}`);
