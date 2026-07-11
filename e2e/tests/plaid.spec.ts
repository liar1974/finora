import { test, expect } from '../fixtures';

// Plaid Link connection flow, stubbed entirely in the browser (page.route +
// a fake window.Plaid) so it hits no network and mutates no server state — the
// interception is per-page, so this is safe to run in parallel on the shared
// main server. Verifies the real frontend flow: Add bank account → Link →
// onSuccess → /v1/plaid/exchange → the account shows up under Banking.
test.describe('plaid link', () => {
  test('connecting a bank via Plaid Link shows the account in Banking', async ({ app }) => {
    const page = app.page;
    let linked = false;
    const fakeAccount = {
      id: 'stub-acct-1',
      name: 'Stubbed Checking',
      institution: 'Stub Bank',
      domain: 'bank',
      type: 'depository',
      currency: 'USD',
    };

    // Never load the real Plaid Link SDK from the CDN; inject a fake that fires
    // onSuccess as soon as the Link handler is opened.
    await page.route(/cdn\.plaid\.com/, (route) => route.abort());
    await page.addInitScript(() => {
      (window as unknown as { Plaid: unknown }).Plaid = {
        create: (opts: { onSuccess: (token: string, meta: unknown) => void }) => ({
          open: () => opts.onSuccess('public-token-stub', { institution: { name: 'Stub Bank' } }),
          exit: () => {},
          destroy: () => {},
        }),
      };
    });

    // Stub the Plaid backend: a link token, a successful exchange, and an
    // accounts list that is empty until the exchange completes.
    await page.route('**/v1/plaid/link-token', (route) =>
      route.fulfill({ json: { link_token: 'link-sandbox-stub' } }));
    await page.route('**/v1/plaid/exchange', (route) => {
      linked = true;
      return route.fulfill({ json: { ok: true } });
    });
    await page.route('**/v1/accounts', (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      return route.fulfill({ json: { items: linked ? [fakeAccount] : [] } });
    });

    await app.open();
    await app.goto('banks');
    await expect(app.view).toContainText('No bank accounts yet');

    await app.view.getByRole('button', { name: 'Add bank account' }).click();

    // Exchange succeeded and the linked account now renders under Banking.
    await expect(app.toast).toContainText(/Bank linked/i);
    await expect(app.view).toContainText('Stubbed Checking');
    await expect(app.view).not.toContainText('No bank accounts yet');
  });
});
