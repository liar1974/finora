import { test, expect } from '../fixtures';

test.describe('rules', () => {
  test('lists the built-in rules and toggles one off', async ({ app }) => {
    await app.goto('settings');
    await app.subtab('insights').click();
    await expect(app.subtab('insights')).toHaveClass(/active/);

    const rows = app.page.locator('.rulerow');
    await expect(rows.first()).toBeVisible();
    expect(await rows.count()).toBeGreaterThan(0);

    // A batch of built-in rules ship enabled. Turning one off persists through
    // /v1/rules/toggle and re-renders, so the "on" count drops by exactly one.
    const enabled = app.page.locator('.switchbtn.on');
    const before = await enabled.count();
    expect(before).toBeGreaterThan(0);

    await enabled.first().click();
    await expect(enabled).toHaveCount(before - 1);
  });

  test('checking for rule updates without a feed URL is handled gracefully', async ({ app }) => {
    await app.goto('settings');
    await app.subtab('insights').click();

    await app.page.locator('#syncRules').click();
    // Server returns skipped:no-feed-url (no network call); the UI toasts a hint.
    await expect(app.toast).toContainText(/feed url/i);
  });

  test('create-rule modal opens and closes', async ({ app }) => {
    await app.goto('settings');
    await app.subtab('insights').click();

    await app.page.locator('#newRuleTopbar').click();
    const modal = app.modal;
    await expect(modal.locator('textarea[name="text"]')).toBeVisible();
    await expect(modal.locator('#previewRule')).toBeVisible();

    await modal.locator('#closeModal').click();
    await expect(modal.locator('textarea[name="text"]')).toHaveCount(0);
  });
});
