#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

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

const args = readArgs(process.argv.slice(2));
const version = required(args, "version");
const baseUrl = required(args, "base-url").replace(/\/+$/, "");
const artifact = required(args, "artifact");
const signature = required(args, "signature");
const platforms = required(args, "platforms").split(",").map(value => value.trim()).filter(Boolean);
const output = required(args, "output");
const notesPath = args.get("notes");

if (!fs.existsSync(artifact)) throw new Error(`Updater artifact not found: ${artifact}`);
if (!fs.existsSync(signature)) throw new Error(`Updater signature not found: ${signature}`);
if (notesPath && !fs.existsSync(notesPath)) throw new Error(`Release notes not found: ${notesPath}`);

const signatureText = fs.readFileSync(signature, "utf8").trim();
const platformEntries = Object.fromEntries(platforms.map(platform => [platform, {
  signature: signatureText,
  url: `${baseUrl}/${path.basename(artifact)}`,
}]));
const manifest = {
  version,
  notes: notesPath ? fs.readFileSync(notesPath, "utf8") : "",
  pub_date: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  platforms: platformEntries,
};

fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.log(`Updater manifest fragment written to ${output}`);
