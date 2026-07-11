import { test, expect } from '../fixtures';

// The Insights feed is the default landing view. Whether or not any findings
// exist, it must render its panel (either zones or an empty-state message)
// without errors.
test.describe('insights feed', () => {
  test('renders the feed panel on the default view', async ({ app }) => {
    await app.open();
    await expect(app.nav('feed')).toHaveClass(/active/);
    await expect(app.view.locator('.feedpanel')).toBeVisible();
  });

  test('navigates back to the feed from another section', async ({ app }) => {
    await app.goto('settings');
    await app.goto('feed');
    await expect(app.view.locator('.feedpanel')).toBeVisible();
  });
});
