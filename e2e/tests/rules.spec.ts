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

  test('previewing a custom rule shows an editable Category, hides the SQL, and posts the override', async ({ app }) => {
    // Stub the model-backed author so the flow runs without a local model. The
    // preview infers scope 'brokerage'; the created rule must carry whatever the
    // user leaves in the Category select (we change it to 'credit').
    await app.page.route('**/v1/rules/custom/preview', (route) =>
      route.fulfill({
        json: {
          text: 'flag idle cash', kind: null, domain: 'brokerage', scope: 'brokerage',
          executionClass: 'D', cadence: 'weekly', scheduledHour: 9, scheduledDay: 1,
          sql: 'SELECT secret_column FROM rules LIMIT 1', title: 'Idle cash', strategy: 'Deterministic query and local copy.',
        },
      }));
    let postedScope = null;
    await app.page.route('**/v1/rules/custom', (route) => {
      postedScope = JSON.parse(route.request().postData() || '{}').scope;
      return route.fulfill({ json: { kind: 'user:idle-cash-abcd1234', source: 'user', active: true } });
    });

    await app.goto('settings');
    await app.subtab('insights').click();
    await app.page.locator('#newRuleTopbar').click();
    const modal = app.modal;

    await modal.locator('textarea[name="text"]').fill('flag idle cash');
    await modal.locator('#previewRule').click();

    // Category is editable and pre-filled with the inferred scope; the schedule
    // card is just the cadence dropdown (no heading/hint); the raw SQL is never shown.
    const category = modal.locator('select[name="scope"]');
    await expect(category).toBeVisible();
    await expect(category).toHaveValue('brokerage');
    await expect(modal.locator('#deliverySettings select[name="cadence"]')).toBeVisible();
    await expect(modal.locator('#deliverySettings .nm, #deliverySettings .cardsub')).toHaveCount(0);
    await expect(modal.locator('.rulesql, pre')).toHaveCount(0);
    await expect(modal).not.toContainText('secret_column');

    // Override the inferred category, then create — the POST carries the override.
    await category.selectOption('credit');
    await modal.locator('#saveRule').click();
    await expect(app.toast).toContainText(/Rule created/i);
    expect(postedScope).toBe('credit');
  });
});
