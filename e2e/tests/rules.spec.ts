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
});
