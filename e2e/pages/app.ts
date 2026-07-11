import { expect } from '@playwright/test';
import type { Page, Locator } from '@playwright/test';

export type Section = 'feed' | 'banks' | 'brokerage' | 'credit' | 'dashboards' | 'settings';

// Thin page-object over the Finora SPA. The app is vanilla JS with hash-based
// navigation (#section/subtab) for banks/brokerage; settings/credit sub-tabs are
// state-driven and reached by clicking the sub-tab chips. Every helper waits for
// the app to have booted (sidebar rendered after the initial data load).
export class AppPage {
  constructor(public readonly page: Page) {}

  get view(): Locator {
    return this.page.getByTestId('view');
  }

  get toast(): Locator {
    return this.page.getByTestId('toast');
  }

  get modal(): Locator {
    return this.page.getByTestId('modal-root');
  }

  nav(section: Section): Locator {
    return this.page.getByTestId(`nav-${section}`);
  }

  subtab(id: string): Locator {
    return this.page.getByTestId(`subtab-${id}`);
  }

  // Load the app and wait until the sidebar navigation has rendered.
  async open(hash = ''): Promise<void> {
    await this.page.goto(`/${hash}`);
    await this.ready();
  }

  async ready(): Promise<void> {
    await expect(this.nav('feed')).toBeVisible();
  }

  // Navigate by clicking the sidebar row (mirrors a real user). Loads the app
  // first if this is a fresh page (about:blank), so specs can call goto() directly.
  async goto(section: Section): Promise<void> {
    if ((await this.nav('feed').count()) === 0) await this.open();
    await this.nav(section).click();
    await expect(this.nav(section)).toHaveClass(/active/);
  }

  // Deep-link via the URL hash (only banks/brokerage sub-tabs are hash-addressable).
  async gotoHash(hash: string): Promise<void> {
    await this.page.goto(`/#${hash}`);
    await this.ready();
  }
}
