#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { chmod, cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const buildOutput = join(root, 'dist', 'desktop');
const desktop = join(root, 'src-tauri', 'resources', 'desktop');
const executableSuffix = process.platform === 'win32' ? '.exe' : '';

function run(command, args) {
  execFileSync(command, args, { cwd: root, stdio: 'inherit' });
}

await rm(desktop, { recursive: true, force: true });
await rm(buildOutput, { recursive: true, force: true });
run('pnpm', ['build']);
run('pnpm', ['build:desktop-backend']);

await mkdir(join(buildOutput, 'backend'), { recursive: true });
await cp(join(root, 'dist', 'http', 'web'), join(buildOutput, 'backend', 'web'), {
  recursive: true,
});
await cp(buildOutput, desktop, { recursive: true });
await writeFile(join(desktop, '.gitkeep'), '');
await mkdir(join(desktop, 'node'), { recursive: true });

const nodeTarget = join(desktop, 'node', `node${executableSuffix}`);
await cp(process.execPath, nodeTarget);
if (process.platform !== 'win32') await chmod(nodeTarget, 0o755);

console.log(`Desktop resources prepared at ${desktop}`);
