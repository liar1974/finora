import { test as base, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppPage } from './pages/app';

const here = dirname(fileURLToPath(import.meta.url));

export type SeedData = { accountId: string };

function readSeed(): SeedData {
  const path = join(here, '.artifacts', 'seed.json');
  return JSON.parse(readFileSync(path, 'utf8')) as SeedData;
}

// Extends the base test with an `app` page-object and the `seed` data written by
// seed.setup.ts, so specs can start from `await app.open()` with known data.
export const test = base.extend<{ app: AppPage; seed: SeedData }>({
  app: async ({ page }, use) => {
    await use(new AppPage(page));
  },
  seed: async ({}, use) => {
    await use(readSeed());
  },
});

export { expect };
