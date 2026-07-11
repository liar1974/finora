import { test, expect } from '../fixtures';

// No brokerage account is seeded, so the section should render its empty-state
// call-to-action rather than a data table.
test.describe('brokerage', () => {
  test('shows the empty-state CTA when no brokerage account exists', async ({ app }) => {
    await app.goto('brokerage');
    await expect(app.view).toContainText('No brokerage accounts yet');
    await expect(app.view.getByRole('button', { name: 'Add brokerage account' })).toBeVisible();
  });

  test('deep-links to the brokerage summary sub-tab via the URL hash', async ({ app }) => {
    await app.gotoHash('brokerage/summary');
    await expect(app.nav('brokerage')).toHaveClass(/active/);
  });
});
