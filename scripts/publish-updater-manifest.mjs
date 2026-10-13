#!/usr/bin/env node
// Publishes a verified updater manifest to the website repository as
// download/<channel>/latest.json. Every check runs before the single write:
//
// 1. the manifest matches the channel, and every referenced package matches
//    the staged asset and signature byte for byte;
// 2. every package downloads anonymously (no credentials are sent) with the
//    staged size and SHA-256;
// 3. the remote manifest is not newer, and the same version is only accepted
//    when it is identical (idempotent re-runs, no silent package swaps);
// 4. the write is conditional on the remote blob that was compared, so a
//    concurrent publication fails instead of being overwritten.
//
// The website token is read from VPASTE_WEBSITE_RELEASE_TOKEN and is only sent
// to api.github.com.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const GITHUB_API = "https://api.github.com";
const CHANNELS = new Set(["stable", "rc"]);

export class PublishError extends Error {}

function readArgs(values) {
  const args = new Map();
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (!key?.startsWith("--") || !value) {
      throw new PublishError(`Invalid argument near ${key ?? "end of command"}`);
    }
    args.set(key.slice(2), value);
  }
  return args;
}

function required(args, key) {
  const value = args.get(key);
  if (!value) throw new PublishError(`Missing required argument --${key}`);
  return value;
}

export function parseReleaseVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-rc\.(\d+))?$/.exec(String(version));
  if (!match) throw new PublishError(`Unsupported release version: ${version}`);
  return {
    core: match.slice(1, 4).map(Number),
    rc: match[4] === undefined ? null : Number(match[4]),
  };
}

/** Semantic version order for the release tag formats this project uses. */
export function compareReleaseVersions(left, right) {
  const a = parseReleaseVersion(left);
  const b = parseReleaseVersion(right);
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index] !== b.core[index]) return a.core[index] < b.core[index] ? -1 : 1;
  }
  if (a.rc === b.rc) return 0;
  if (a.rc === null) return 1;
  if (b.rc === null) return -1;
  return a.rc < b.rc ? -1 : 1;
}

export function assertChannelVersion(channel, version) {
  if (!CHANNELS.has(channel)) throw new PublishError(`Unsupported update channel: ${channel}`);
  const { rc } = parseReleaseVersion(version);
  if (channel === "stable" && rc !== null) {
    throw new PublishError(`Stable channel cannot publish prerelease ${version}`);
  }
  if (channel === "rc" && rc === null) {
    throw new PublishError(`RC channel only publishes -rc versions, got ${version}`);
  }
}

function platformEntries(manifest) {
  if (!manifest || typeof manifest !== "object" || !manifest.platforms || typeof manifest.platforms !== "object") {
    throw new PublishError("Updater manifest has no platforms");
  }
  return Object.entries(manifest.platforms).sort(([a], [b]) => a.localeCompare(b));
}

/** Release identity: version plus every platform URL and signature. */
export function sameRelease(left, right) {
  if (left.version !== right.version) return false;
  const a = platformEntries(left);
  const b = platformEntries(right);
  return a.length === b.length && a.every(([platform, entry], index) => {
    const [otherPlatform, other] = b[index];
    return platform === otherPlatform && entry.url === other.url && entry.signature === other.signature;
  });
}

/**
 * Decides how to publish `next` over the remote manifest. Returns "create",
 * "update" or "unchanged" and throws for downgrades and same-version changes.
 */
export function decidePublication(existing, next) {
  if (existing === null) return "create";
  if (!existing || typeof existing.version !== "string") {
    throw new PublishError("The published manifest is not a valid updater manifest; fix it manually first");
  }
  const order = compareReleaseVersions(existing.version, next.version);
  if (order > 0) {
    throw new PublishError(`The published manifest already points to newer ${existing.version}; refusing to publish ${next.version}`);
  }
  if (order === 0) {
    if (sameRelease(existing, next)) return "unchanged";
    throw new PublishError(`The published manifest for ${next.version} references different packages or signatures; refusing to replace them`);
  }
  return "update";
}

function assetNameFromUrl(value) {
  const name = decodeURIComponent(new URL(value).pathname.split("/").at(-1) ?? "");
  if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\")) {
    throw new PublishError(`Invalid package URL ${value}`);
  }
  return name;
}

/** Size and SHA-256 of the staged package behind each manifest platform. */
export function stagedPackageDigests(manifest, assetsDir) {
  return platformEntries(manifest).map(([platform, entry]) => {
    const name = assetNameFromUrl(entry.url);
    const assetPath = path.join(assetsDir, name);
    if (!fs.existsSync(assetPath)) throw new PublishError(`Staged asset ${name} is missing`);
    const signaturePath = `${assetPath}.sig`;
    if (fs.existsSync(signaturePath) && fs.readFileSync(signaturePath, "utf8").trim() !== entry.signature.trim()) {
      throw new PublishError(`Platform ${platform} signature does not match ${name}.sig`);
    }
    const bytes = fs.readFileSync(assetPath);
    return {
      platform,
      url: entry.url,
      size: bytes.length,
      sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    };
  });
}

async function readBody(response) {
  const hash = crypto.createHash("sha256");
  let size = 0;
  if (response.body && typeof response.body.getReader === "function") {
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      hash.update(value);
    }
  } else {
    const bytes = Buffer.from(await response.arrayBuffer());
    size = bytes.length;
    hash.update(bytes);
  }
  return { size, sha256: hash.digest("hex") };
}

/**
 * Downloads every package without credentials and compares it with the staged
 * file. A HEAD request or a 200 status alone is not enough.
 */
export async function verifyAnonymousDownloads(digests, fetchImpl = fetch) {
  for (const digest of digests) {
    const response = await fetchImpl(digest.url, { redirect: "follow", credentials: "omit" });
    if (!response.ok) {
      throw new PublishError(`Anonymous download of ${digest.platform} package failed with HTTP ${response.status}`);
    }
    const downloaded = await readBody(response);
    if (downloaded.size !== digest.size || downloaded.sha256 !== digest.sha256) {
      throw new PublishError(`Anonymous download of ${digest.platform} package does not match the verified asset`);
    }
    console.log(`Verified anonymous download for ${digest.platform} (${digest.size} bytes)`);
  }
}

function githubHeaders(token) {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

function contentsUrl(repo, filePath) {
  return `${GITHUB_API}/repos/${repo}/contents/${filePath.split("/").map(encodeURIComponent).join("/")}`;
}

export async function readPublishedManifest({ repo, branch, filePath, token, fetchImpl = fetch }) {
  const url = `${contentsUrl(repo, filePath)}?ref=${encodeURIComponent(branch)}`;
  const response = await fetchImpl(url, { headers: githubHeaders(token) });
  if (response.status === 404) return { manifest: null, sha: null };
  if (!response.ok) throw new PublishError(`Reading ${repo}/${filePath} failed with HTTP ${response.status}`);
  const body = await response.json();
  const text = Buffer.from(String(body.content ?? ""), "base64").toString("utf8");
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch {
    manifest = undefined;
  }
  return { manifest, sha: body.sha };
}

export async function writePublishedManifest({ repo, branch, filePath, token, manifest, sha, fetchImpl = fetch }) {
  const response = await fetchImpl(contentsUrl(repo, filePath), {
    method: "PUT",
    headers: { ...githubHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify({
      message: `Publish vPaste ${manifest.version} updater manifest`,
      content: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8").toString("base64"),
      branch,
      ...(sha ? { sha } : {}),
    }),
  });
  if (response.status === 409 || response.status === 422) {
    throw new PublishError(`${repo}/${filePath} changed while publishing (HTTP ${response.status}); re-check the remote manifest and retry`);
  }
  if (!response.ok) throw new PublishError(`Writing ${repo}/${filePath} failed with HTTP ${response.status}`);
}

export async function waitForPublicManifest({ url, manifest, attempts = 30, delayMs = 20_000, fetchImpl = fetch, sleep }) {
  const wait = sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchImpl(`${url}?verify=${Date.now()}`, { credentials: "omit", cache: "no-store" });
      if (response.ok && sameRelease(await response.json(), manifest)) {
        console.log(`Public manifest ${url} serves ${manifest.version}`);
        return;
      }
    } catch {
      // Not deployed yet or not valid JSON; retry.
    }
    if (attempt < attempts) await wait(delayMs);
  }
  throw new PublishError(`Public manifest ${url} did not serve ${manifest.version} in time; check the website deployment`);
}

export async function publishUpdaterManifest({
  manifest,
  channel,
  assetsDir,
  repo,
  branch,
  token,
  publicUrl,
  fetchImpl = fetch,
  publicAttempts,
  publicDelayMs,
  sleep,
}) {
  if (!token) throw new PublishError("VPASTE_WEBSITE_RELEASE_TOKEN is not configured");
  assertChannelVersion(channel, manifest.version);
  const digests = stagedPackageDigests(manifest, assetsDir);
  await verifyAnonymousDownloads(digests, fetchImpl);

  const filePath = `download/${channel}/latest.json`;
  const published = await readPublishedManifest({ repo, branch, filePath, token, fetchImpl });
  const decision = decidePublication(published.manifest, manifest);
  if (decision === "unchanged") {
    console.log(`${repo}/${filePath} already publishes ${manifest.version}; nothing to write`);
  } else {
    await writePublishedManifest({ repo, branch, filePath, token, manifest, sha: published.sha, fetchImpl });
    console.log(`Wrote ${manifest.version} to ${repo}/${filePath} (${decision})`);
  }
  if (publicUrl) {
    await waitForPublicManifest({
      url: publicUrl,
      manifest,
      attempts: publicAttempts,
      delayMs: publicDelayMs,
      fetchImpl,
      sleep,
    });
  }
  return decision;
}

async function main() {
  const args = readArgs(process.argv.slice(2));
  const manifest = JSON.parse(fs.readFileSync(required(args, "manifest"), "utf8"));
  const tag = required(args, "tag");
  if (tag !== `v${manifest.version}`) {
    throw new PublishError(`Manifest version ${manifest.version} does not match tag ${tag}`);
  }
  await publishUpdaterManifest({
    manifest,
    channel: required(args, "channel"),
    assetsDir: required(args, "assets-dir"),
    repo: required(args, "website-repo"),
    branch: args.get("branch") ?? "main",
    token: process.env.VPASTE_WEBSITE_RELEASE_TOKEN ?? "",
    publicUrl: args.get("public-url"),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(error instanceof PublishError ? error.message : `Publishing failed: ${error?.message ?? error}`);
    process.exit(1);
  });
}
