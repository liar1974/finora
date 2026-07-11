import { defineConfig, devices } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A throwaway data dir per server: a fresh SQLite DB (auto-migrated, empty but
// seeded with the built-in rules) and an empty models dir so no local LLM
// weights are ever loaded. All external gateways are turned off so the run is
// hermetic — no Plaid/Telegram/network calls fire.
//
// Two isolated servers:
//  - main (3999): shared by the read-mostly specs; seeded with a known account.
//  - onboarding (3997): its own empty DB, so the onboarding specs can freely
//    write global settings (Plaid keys, delivery channels, model provider)
//    without racing the main suite's Telegram/channel assertions.
function makeEnv(port: string) {
  const dir = mkdtempSync(join(tmpdir(), 'finora-e2e-'));
  return {
    FINORA_HOST: '127.0.0.1',
    FINORA_PORT: port,
    FINORA_DATABASE_PATH: join(dir, 'finora-e2e.db'),
    FINORA_DATA_DIR: dir,
    FINORA_MODELS_DIR: join(dir, 'models'),
    CHAT_GATEWAY: 'off',
    AUTO_SYNC: 'off',
    ALERTS_ENABLED: 'off',
  };
}

const HOST = '127.0.0.1';
const MAIN_PORT = process.env.FINORA_E2E_PORT ?? '3999';
const ONBOARDING_PORT = process.env.FINORA_E2E_ONBOARDING_PORT ?? '3997';
const baseURL = `http://${HOST}:${MAIN_PORT}`;
const onboardingURL = `http://${HOST}:${ONBOARDING_PORT}`;

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
      // Onboarding runs on its own server/project (see below).
      testIgnore: /onboarding\.spec\.ts/,
    },
    {
      name: 'onboarding',
      testMatch: /onboarding\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], baseURL: onboardingURL },
    },
  ],
  // The web bundle is built once by `pnpm test:e2e` before Playwright starts, so
  // both servers just `tsx src/cli.ts serve` and share the prebuilt dist/http/web
  // (no concurrent vite builds racing on the same output dir). The CLI path needs
  // no desktop auth token, so /v1/* is reachable without headers.
  webServer: [
    {
      command: 'tsx src/cli.ts serve',
      url: `${baseURL}/v1/health`,
      timeout: 120_000,
      reuseExistingServer: !process.env.CI,
      env: makeEnv(MAIN_PORT),
    },
    {
      command: 'tsx src/cli.ts serve',
      url: `${onboardingURL}/v1/health`,
      timeout: 120_000,
      reuseExistingServer: !process.env.CI,
      env: makeEnv(ONBOARDING_PORT),
    },
  ],
});
