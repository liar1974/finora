import { test, expect } from '../fixtures';

// There is no parseable credit-report PDF fixture in the repo, so this verifies
// the upload surface exists and that an unparseable file is handled gracefully
// (error message shown, no crash) — not a successful parse.
test.describe('credit', () => {
  test('rejects an unparseable upload with an error message', async ({ app }) => {
    await app.goto('credit');
    // The upload form lives in the "Manage reports" modal.
    await app.page.locator('#manageCreditReports').click();

    const input = app.modal.getByTestId('credit-file-input');
    await expect(input).toBeAttached();

    await input.setInputFiles({
      name: 'not-a-real-report.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('this is not a valid PDF document'),
    });

    const message = app.modal.getByTestId('credit-message');
    await expect(message).toHaveClass(/error/);
    await expect(message).not.toBeEmpty();
    // The app is still alive and interactive after the failure.
    await expect(app.nav('credit')).toHaveClass(/active/);
  });

  test('reports sub-tab shows an empty state when nothing is uploaded', async ({ app }) => {
    await app.goto('credit');
    await app.subtab('reports').click();
    await expect(app.subtab('reports')).toHaveClass(/active/);
    await expect(app.view).toContainText('No uploaded credit report PDFs yet');
  });

  test('manage-reports modal opens and closes', async ({ app }) => {
    await app.goto('credit');
    await app.page.locator('#manageCreditReports').click();
    await expect(app.modal.getByTestId('credit-file-input')).toBeAttached();

    await app.modal.locator('#closeModal').click();
    await expect(app.modal.getByTestId('credit-file-input')).toHaveCount(0);
  });
});
