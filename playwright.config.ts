import { defineConfig, devices } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A throwaway data dir per test process: a fresh SQLite DB (auto-migrated, empty
// but seeded with the built-in rules) and an empty models dir so no local LLM
// weights are ever loaded. All external gateways are turned off so the run is
// hermetic — no Plaid/Telegram/network calls fire.
const dataDir = mkdtempSync(join(tmpdir(), 'finora-e2e-'));

const HOST = '127.0.0.1';
const PORT = process.env.FINORA_E2E_PORT ?? '3999';
const baseURL = `http://${HOST}:${PORT}`;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: [['html', { open: 'never' }], ['list']],
  timeout: 30_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'on-first-retry',
  },
  projects: [
    { name: 'setup', testMatch: /seed\.setup\.ts/ },
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      dependencies: ['setup'],
    },
  ],
  // Build the web bundle, then boot the real `finora serve` via tsx. Assets are
  // served from dist/http/web (produced by build:web); the CLI path needs no
  // desktop auth token, so /v1/* is reachable without headers.
  webServer: {
    command: 'pnpm build:web && tsx src/cli.ts serve',
    url: `${baseURL}/v1/health`,
    timeout: 120_000,
    reuseExistingServer: !process.env.CI,
    env: {
      FINORA_HOST: HOST,
      FINORA_PORT: PORT,
      FINORA_DATABASE_PATH: join(dataDir, 'finora-e2e.db'),
      FINORA_DATA_DIR: dataDir,
      FINORA_MODELS_DIR: join(dataDir, 'models'),
      CHAT_GATEWAY: 'off',
      AUTO_SYNC: 'off',
      ALERTS_ENABLED: 'off',
    },
  },
});
