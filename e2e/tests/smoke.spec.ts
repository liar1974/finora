import { test, expect } from '../fixtures';

test.describe('smoke', () => {
  test('serves a healthy backend', async ({ request }) => {
    const res = await request.get('/v1/health');
    expect(res.ok()).toBeTruthy();
    expect(await res.json()).toMatchObject({ status: 'ok' });
  });

  test('boots the app with all navigation sections', async ({ app }) => {
    await app.open();
    for (const section of ['feed', 'banks', 'brokerage', 'credit', 'dashboards', 'settings'] as const) {
      await expect(app.nav(section)).toBeVisible();
    }
    // Feed is the default landing section.
    await expect(app.nav('feed')).toHaveClass(/active/);
  });
});
