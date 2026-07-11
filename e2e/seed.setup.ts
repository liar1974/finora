import { test as setup, expect } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const artifactsDir = join(here, '.artifacts');
const seedFile = join(artifactsDir, 'seed.json');

// Seeds a known bank account + a handful of transactions through the public HTTP
// API, so data-dependent specs (banking table, etc.) have deterministic rows to
// assert against. Runs once as a `setup` project the chromium project depends on,
// which guarantees the webServer is already listening. Idempotent: reuses an
// existing account so re-runs against a warm dev server don't pile up duplicates.
setup('seed a bank account and transactions', async ({ request }) => {
  const existing = await request.get('/v1/accounts');
  expect(existing.ok()).toBeTruthy();
  const accounts = (await existing.json()).items as Array<{ id: string; name: string }>;

  let accountId = accounts.find((a) => a.name === 'Checking')?.id;
  if (!accountId) {
    const created = await request.post('/v1/accounts', {
      data: { institution: 'Example Bank', name: 'Checking' },
    });
    expect(created.status()).toBe(201);
    accountId = (await created.json()).id as string;

    const csv = readFileSync(join(repoRoot, 'test/fixtures/checking.csv'));
    const imported = await request.post('/v1/imports', {
      data: {
        accountId,
        filename: 'checking.csv',
        contentBase64: csv.toString('base64'),
      },
    });
    expect(imported.status()).toBe(200);
    expect((await imported.json()).insertedCount).toBeGreaterThan(0);
  }

  mkdirSync(artifactsDir, { recursive: true });
  writeFileSync(seedFile, JSON.stringify({ accountId }, null, 2));
});
