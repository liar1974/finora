import { test, expect } from '../fixtures';

// New-user onboarding journey, mirroring docs/onboarding.md. Runs against a
// dedicated, empty server (see the `onboarding` project in playwright.config.ts)
// so these global-settings writes don't race the main suite. Serial so the
// read-only first-launch checks run before any configuration is written.
test.describe.configure({ mode: 'serial' });

test.describe('onboarding', () => {
  test('first launch: all sections present and data areas empty', async ({ app }) => {
    await app.open();
    for (const section of ['feed', 'banks', 'brokerage', 'credit', 'dashboards', 'settings'] as const) {
      await expect(app.nav(section)).toBeVisible();
    }

    // Banking and Brokerage show their "connect" call-to-action, not a table.
    await app.goto('banks');
    await expect(app.view).toContainText('No bank accounts yet');
    await expect(app.view.getByRole('button', { name: 'Add bank account' })).toBeVisible();

    await app.goto('brokerage');
    await expect(app.view).toContainText('No brokerage accounts yet');
    await expect(app.view.getByRole('button', { name: 'Add brokerage account' })).toBeVisible();
  });

  test('step 3: saving Plaid keys persists the credentials', async ({ app }) => {
    await app.goto('settings');
    await app.subtab('accounts').click();
    await expect(app.subtab('accounts')).toHaveClass(/active/);

    // Before setup, the panel prompts to save credentials.
    await expect(app.view).toContainText('Save the app-level Plaid credentials');

    await app.view.locator('input[name="PLAID_CLIENT_ID"]').fill('test-client-id');
    await app.view.locator('input[name="PLAID_SECRET"]').fill('test-sandbox-secret');
    await app.view.getByRole('button', { name: 'Save' }).click();

    // After saving, the panel reflects that credentials are stored (re-rendered
    // from the reloaded settings — proves the write persisted).
    await expect(app.view).toContainText('Plaid credentials are saved');
  });

  test('step 5: saving a Telegram bot token confirms the next step', async ({ app }) => {
    await app.goto('settings');
    await app.subtab('delivery').click();

    // Explicitly select the Telegram channel (robust even if a prior run left the
    // channel on Slack), then fill the bot token and save credentials.
    await app.view.getByRole('button', { name: /Telegram/ }).first().click();
    await expect(app.view.locator('input[name="TELEGRAM_BOT_TOKEN"]')).toBeVisible();
    await app.view.locator('input[name="TELEGRAM_BOT_TOKEN"]').fill('123456:test-bot-token');
    await app.view.getByRole('button', { name: 'Save credentials' }).click();

    // The credentials persist (settings write, no network). The connect-chat step
    // is now available for the user to complete in Telegram.
    await expect(app.toast).toContainText(/saved/i);
    await expect(app.page.locator('#connectTelegram')).toBeVisible();
  });

  test('step 5: switching to Slack and saving its credentials', async ({ app }) => {
    await app.goto('settings');
    await app.subtab('delivery').click();

    // Pick the Slack channel — this commits NOTIFICATION_CHANNEL and re-renders
    // the Slack setup form.
    await app.view.getByRole('button', { name: /Slack/ }).first().click();
    const botToken = app.view.locator('input[name="SLACK_BOT_TOKEN"]');
    await expect(botToken).toBeVisible();

    await botToken.fill('xoxb-test-token');
    await app.view.locator('input[name="SLACK_CHANNEL_ID"]').fill('C0123456789');
    await app.view.getByRole('button', { name: 'Save credentials' }).click();

    await expect(app.toast).toContainText(/saved/i);
  });

  test('models: choosing a hosted provider reveals the API key field', async ({ app }) => {
    await app.goto('settings');
    await app.subtab('models').click();

    const provider = app.view.locator('select[name="LLM_PROVIDER"]');
    await expect(provider).toBeVisible();

    // Pick the first non-built-in (hosted) provider; built-in needs no key, hosted
    // providers do. The dropdown commits immediately and re-renders the API form.
    const values = await provider.locator('option').evaluateAll((opts) =>
      (opts as HTMLOptionElement[]).map((o) => o.value),
    );
    const hosted = values.find((v) => v && v !== 'builtin');
    expect(hosted, 'expected at least one hosted provider').toBeTruthy();
    await provider.selectOption(hosted!);

    // The API key field is disabled for the built-in model and enabled once a
    // hosted provider is selected.
    const apiKey = app.view.locator('input[name="LLM_API_KEY"]:not([disabled])');
    await expect(apiKey).toBeVisible();
    await apiKey.fill('sk-test-key');
    await app.view.getByRole('button', { name: 'Save' }).click();
    await expect(app.toast).toContainText(/saved/i);
  });
});
