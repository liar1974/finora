import { test, expect } from '../fixtures';

// The E2E server runs with no credentials, so credential-gated actions must fail
// gracefully with a friendly message rather than crash the UI. These assert the
// degraded path, not success.
test.describe('settings validation', () => {
  test('connecting Telegram without a bot token surfaces a friendly error', async ({ app }) => {
    await app.goto('settings');
    await app.subtab('delivery').click();

    const connect = app.page.locator('#connectTelegram');
    await expect(connect).toBeVisible();
    await connect.click();

    const message = app.page.locator('#telegramConnectMessage');
    // Backend returns HTTP 422 "Save a Telegram bot token first." — the UI shows it
    // in the connect message with the error class, and does not blow up.
    await expect(message).toContainText(/token/i);
    await expect(message).toHaveClass(/error/);
    await expect(app.nav('settings')).toHaveClass(/active/);
  });

  test('models tab renders the provider configuration', async ({ app }) => {
    await app.goto('settings');
    await app.subtab('models').click();
    await expect(app.subtab('models')).toHaveClass(/active/);
    // The LLM provider selector is the stable anchor of the models tab.
    await expect(app.page.locator('select[name="LLM_PROVIDER"]')).toBeVisible();
  });
});
