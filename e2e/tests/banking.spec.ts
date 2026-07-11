import { test, expect } from '../fixtures';

test.describe('banking', () => {
  test('shows the seeded transactions in the table', async ({ app }) => {
    await app.gotoHash('banks/transactions');
    await expect(app.subtab('transactions')).toHaveClass(/active/);

    const table = app.page.getByTestId('data-table');
    await expect(table).toBeVisible();
    // Descriptions imported from test/fixtures/checking.csv.
    await expect(table).toContainText('Neighborhood Market');
    await expect(table).toContainText('Salary');
    await expect(table).toContainText('Electric Utility');
  });

  test('summary tab renders the seeded account', async ({ app }) => {
    await app.goto('banks');
    await expect(app.subtab('summary')).toHaveClass(/active/);
    await expect(app.view).toContainText('Checking');
  });
});
