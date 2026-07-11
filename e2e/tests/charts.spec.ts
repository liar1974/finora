import { test, expect } from '../fixtures';

// Chart creation is entirely client-side (customChartFromPrompt / vega), so this
// flow needs no LLM or network — a good deterministic end-to-end check.
test.describe('charts', () => {
  test('creates a chart from a prompt and adds it to the dashboard', async ({ app }) => {
    await app.goto('dashboards');

    const cards = app.page.getByTestId('chart-card');
    const before = await cards.count();

    await app.page.locator('#openChartCreator').click();
    const modal = app.modal;
    await expect(modal.locator('#previewChart')).toBeVisible();

    await modal.locator('textarea[name="prompt"]').fill('Top merchants bar chart');
    await modal.locator('#previewChart').click();

    // Preview renders in-browser.
    await expect(modal.locator('#chartPreviewState')).toHaveText('Ready');
    await expect(modal.locator('#chartPreview')).not.toHaveClass(/empty/);

    await modal.locator('#saveChart').click();

    await expect(app.toast).toContainText('Chart saved');
    await expect(cards).toHaveCount(before + 1);
  });
});
