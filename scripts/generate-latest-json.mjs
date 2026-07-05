#!/usr/bin/env node
// Generates the Tauri updater manifest (latest.json) from the release artifacts.
//
// The desktop app's updater plugin fetches
//   https://github.com/<repo>/releases/latest/download/latest.json
// and, for the current platform, downloads the `url` and verifies it against the
// `signature` (minisign) using the public key baked into tauri.conf.json. This
// script scans the collected build artifacts, pairs each updater bundle with its
// `.sig`, and writes latest.json with versioned download URLs for the release.
//
// Usage (from CI):
//   RELEASE_TAG=v0.2.0 REPO=liar1974/finora ARTIFACTS_DIR=artifacts \
//     node scripts/generate-latest-json.mjs
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const tag = process.env.RELEASE_TAG;
const repo = process.env.REPO;
const artifactsDir = process.env.ARTIFACTS_DIR ?? 'artifacts';
if (!tag || !repo) {
  console.error('RELEASE_TAG and REPO environment variables are required');
  process.exit(1);
}
const version = tag.replace(/^v/, '');

const files = readdirSync(artifactsDir);
const downloadUrl = (name) =>
  `https://github.com/${repo}/releases/download/${tag}/${encodeURIComponent(name)}`;

// Each platform key maps to a matcher for its updater bundle. Order matters:
// the first file that matches and is NOT a signature wins.
const platforms = {
  'darwin-aarch64': (name) => /aarch64\.app\.tar\.gz$/.test(name),
  'darwin-x86_64': (name) => /(x64|x86_64)\.app\.tar\.gz$/.test(name),
  'windows-x86_64': (name) => /-setup\.exe$/.test(name),
  'linux-x86_64': (name) => /\.AppImage$/.test(name),
};

const result = {};
for (const [key, matches] of Object.entries(platforms)) {
  const bundle = files.find((name) => matches(name) && !name.endsWith('.sig'));
  if (!bundle) {
    console.warn(`No updater bundle found for ${key} — skipping`);
    continue;
  }
  const sigName = `${bundle}.sig`;
  if (!files.includes(sigName)) {
    console.warn(`Missing signature ${sigName} for ${bundle} — skipping ${key}`);
    continue;
  }
  const signature = readFileSync(join(artifactsDir, sigName), 'utf8').trim();
  result[key] = { signature, url: downloadUrl(bundle) };
  console.log(`${key}: ${bundle}`);
}

if (Object.keys(result).length === 0) {
  // No .sig files means the signing secrets are not configured yet. Skip the
  // manifest so the release still publishes; auto-update simply stays dormant
  // until TAURI_SIGNING_PRIVATE_KEY is added and a signed release is cut.
  console.warn('No signed updater artifacts found; skipping latest.json (is TAURI_SIGNING_PRIVATE_KEY set?)');
  process.exit(0);
}

const manifest = {
  version,
  notes: `See https://github.com/${repo}/releases/tag/${tag} for release notes.`,
  pub_date: new Date().toISOString(),
  platforms: result,
};

const outPath = join(artifactsDir, 'latest.json');
writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Wrote ${outPath} for version ${version}`);
