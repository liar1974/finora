# E2E tests (Playwright)

Browser-level end-to-end tests for the Finora web UI. They drive the real
`finora serve` app in Chromium against a throwaway database, with all external
gateways (Plaid, Telegram, LLM) disabled — no network, no credentials, fully
hermetic.

## Running

```bash
pnpm e2e:install     # once — downloads the Chromium browser
pnpm test:e2e        # run the suite headless
pnpm test:e2e:ui     # interactive UI mode
pnpm exec playwright test smoke            # run one file
pnpm exec playwright test --headed         # watch it drive the browser
pnpm exec playwright show-report           # open the last HTML report
```

You don't need to start the server yourself: `playwright.config.ts` launches it
via a `webServer` (`pnpm build:web && tsx src/cli.ts serve`) on `127.0.0.1:3999`
with a temp DB (`FINORA_DATABASE_PATH`), an empty models dir, and
`CHAT_GATEWAY/AUTO_SYNC/ALERTS_ENABLED=off`. Locally an already-running server on
that port is reused; in CI a fresh one is always started.

## Projects & servers

Two hermetic servers run in parallel (both `tsx src/cli.ts serve`, temp DB, empty
models dir, gateways off). The web bundle is built once by `pnpm test:e2e` before
Playwright starts, so the two servers share `dist/http/web` without racing on it.

- **`chromium`** (server `:3999`) — the main suite. Depends on the **`setup`**
  project (`seed.setup.ts`), which seeds a known bank account + transactions via
  the public API and writes `e2e/.artifacts/seed.json`. Read-mostly specs.
- **`onboarding`** (server `:3997`) — `onboarding.spec.ts` only, on its own empty
  DB. The onboarding journey *writes global settings* (Plaid keys, delivery
  channels, model provider), so it's isolated here to avoid racing the main
  suite's Telegram/channel assertions. Runs `serial`; each test is idempotent
  (re-selects its channel/provider) so a reused server stays green across runs.

## Layout

- `playwright.config.ts` (repo root) — the two projects/servers above.
- `e2e/fixtures.ts` — extends the base test with an `app` page-object and the
  `seed` data. Import `test`/`expect` from here, not from `@playwright/test`.
  (Onboarding specs use `app` only, never `seed`.)
- `e2e/pages/app.ts` — page-object over the SPA (navigation, sub-tabs, modal,
  toast). `app.goto(section)` auto-loads the app on a fresh page.
- `e2e/tests/*.spec.ts` — the specs.

## Shared state & assertions

The main server's DB is shared across parallel specs, so specs assert on
seeded/immutable state or their own isolated keys — avoid writing global settings
there (do that in the `onboarding` project). Forms that call `renderSettings()`
after saving wipe their inline `.message`, so assert the **toast** (a stable
success signal whose text persists) rather than the in-form message.

## Selector convention

The frontend is vanilla JS with hash routing. Prefer, in order:

1. `data-testid` hooks: `view`, `toast`, `modal-root`, `chat-input`,
   `chat-send`, `nav-<section>`, `subtab-<id>`, `data-table`, `chart-card`,
   `credit-dropzone`, `credit-file-input`, `credit-message`.
2. Stable element ids that already exist (`#openChartCreator`, `#previewChart`,
   `#saveChart`, `#connectTelegram`, `#telegramConnectMessage`, …). Modals reuse
   `#closeModal`, so scope modal assertions with `app.modal`.
3. Roles / text as a last resort.

When you need a new hook, add a `data-testid` at the render site in
`src/http/web/app.js` (or `main.jsx`) rather than relying on brittle text.

## Notes

- LLM/credential-gated flows are asserted on their **graceful-degradation** path
  (e.g. Telegram connect → HTTP 422 friendly message), not on success, since the
  E2E server has no model or credentials.
- There is no parseable credit-report PDF fixture, so `credit.spec.ts` only
  verifies the upload UI and error handling for an invalid file.
