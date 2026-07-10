#!/usr/bin/env node
// Stamps a version into the desktop app's source of truth before a release build.
//
// Tauri bakes the version into every bundle filename (e.g. Finora_0.1.0_aarch64.dmg)
// from src-tauri/tauri.conf.json. To make the release tag the single source of truth,
// CI runs this before `tauri build` so the tag `vX.Y.Z` produces Finora_X.Y.Z_* files
// AND a latest.json whose advertised version matches the bundle inside it (otherwise
// the auto-updater re-offers the same update forever).
//
// Updates: package.json, src-tauri/tauri.conf.json (JSON), src-tauri/Cargo.toml
// (the [package] version only — never a dependency version).
//
// Usage:
//   node scripts/set-version.mjs 0.1.1
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const version = process.argv[2];
if (!version) {
  console.error('Usage: node scripts/set-version.mjs <version>   (e.g. 0.1.1)');
  process.exit(1);
}
if (!/^\d+\.\d+\.\d+(?:[-+].+)?$/.test(version)) {
  console.error(`Refusing to stamp an unexpected version string: "${version}"`);
  console.error('Expected semver like 0.1.1 (tag should be v0.1.1).');
  process.exit(1);
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function setJsonVersion(relPath) {
  const path = join(root, relPath);
  const json = JSON.parse(readFileSync(path, 'utf8'));
  json.version = version;
  writeFileSync(path, `${JSON.stringify(json, null, 2)}\n`);
  console.log(`${relPath}: version -> ${version}`);
}

function setCargoVersion(relPath) {
  const path = join(root, relPath);
  const text = readFileSync(path, 'utf8');
  // Replace the version key inside the first [package] table only. The regex
  // anchors on the [package] header and stops at the next table header so a
  // dependency's version = "..." is never touched.
  const replaced = text.replace(
    /(\[package\][^[]*?\nversion\s*=\s*")[^"]*(")/,
    `$1${version}$2`,
  );
  if (replaced === text) {
    console.error(`Could not find [package] version in ${relPath}`);
    process.exit(1);
  }
  writeFileSync(path, replaced);
  console.log(`${relPath}: [package] version -> ${version}`);
}

setJsonVersion('package.json');
setJsonVersion('src-tauri/tauri.conf.json');
setCargoVersion('src-tauri/Cargo.toml');
