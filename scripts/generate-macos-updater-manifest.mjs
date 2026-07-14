#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

function readArgs(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith('--')) {
      throw new Error(`Unexpected argument: ${value}`);
    }
    const key = value.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      throw new Error(`Missing value for --${key}`);
    }
    args.set(key, next);
    index += 1;
  }
  return args;
}

function required(args, key) {
  const value = args.get(key);
  if (!value) {
    throw new Error(`Missing required argument --${key}`);
  }
  return value;
}

const args = readArgs(process.argv.slice(2));
const baseUrl = required(args, 'base-url').replace(/\/+$/, '');
const version = required(args, 'version');
const artifact = required(args, 'artifact');
const signature = required(args, 'signature');
const platformKeys = required(args, 'platform-keys')
  .split(',')
  .map((key) => key.trim())
  .filter(Boolean);
const output = args.get('output') || 'src-tauri/target/release/bundle/updater/latest.json';
const notesPath = args.get('notes-path') || '';

if (platformKeys.length === 0) {
  throw new Error('At least one platform key is required');
}
if (!fs.existsSync(artifact)) {
  throw new Error(`Updater artifact not found: ${artifact}`);
}
if (!fs.existsSync(signature)) {
  throw new Error(`Updater signature not found: ${signature}`);
}
if (notesPath && !fs.existsSync(notesPath)) {
  throw new Error(`Notes file not found: ${notesPath}`);
}

const signatureText = fs.readFileSync(signature, 'utf8').trim();
const artifactName = path.basename(artifact);
const notes = notesPath ? fs.readFileSync(notesPath, 'utf8') : '';
const platforms = {};

for (const platformKey of platformKeys) {
  platforms[platformKey] = {
    signature: signatureText,
    url: `${baseUrl}/${artifactName}`,
  };
}

const manifest = {
  version,
  notes,
  pub_date: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  platforms,
};

fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
console.log(`macOS updater manifest written to ${output}`);
