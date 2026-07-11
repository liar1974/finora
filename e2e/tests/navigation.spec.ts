import { test, expect } from '../fixtures';
import type { Section } from '../pages/app';

const sections: Section[] = ['feed', 'banks', 'brokerage', 'credit', 'dashboards', 'settings'];

test.describe('navigation', () => {
  test('clicking each sidebar section marks it active', async ({ app }) => {
    await app.open();
    for (const section of sections) {
      await app.goto(section);
      await expect(app.nav(section)).toHaveClass(/active/);
      // Exactly one section is active at a time.
      await expect(app.page.locator('.navrow.active')).toHaveCount(1);
    }
  });

  test('banking sub-tabs switch via chips', async ({ app }) => {
    await app.open();
    await app.goto('banks');
    for (const tab of ['summary', 'transactions', 'cashflow', 'recurring']) {
      await app.subtab(tab).click();
      await expect(app.subtab(tab)).toHaveClass(/active/);
    }
  });

  test('deep-links to a banking sub-tab via the URL hash', async ({ app }) => {
    await app.gotoHash('banks/transactions');
    await expect(app.nav('banks')).toHaveClass(/active/);
    await expect(app.subtab('transactions')).toHaveClass(/active/);
  });

  test('settings sub-tabs switch via chips', async ({ app }) => {
    await app.open();
    await app.goto('settings');
    for (const tab of ['models', 'accounts', 'delivery', 'insights']) {
      await app.subtab(tab).click();
      await expect(app.subtab(tab)).toHaveClass(/active/);
    }
  });
});
