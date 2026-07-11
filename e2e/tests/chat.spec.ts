import { test, expect } from '../fixtures';

test.describe('chat assistant', () => {
  test('sending a message with no model shows a graceful "unavailable" reply', async ({ app }) => {
    await app.open();
    await app.page.getByTestId('chat-input').fill('hello');
    await app.page.getByTestId('chat-send').click();

    const msgs = app.page.locator('#msgs');
    // The user's message is echoed immediately.
    await expect(msgs.locator('.msg.user')).toContainText('hello');
    // The E2E server has no downloaded model, so /v1/chat returns 422 and the
    // assistant bubble degrades to a clear message instead of hanging.
    await expect(msgs.locator('.msg.bot')).toContainText(/Model unavailable/i);
    // App stays interactive.
    await expect(app.nav('feed')).toBeVisible();
  });

  test('new-thread button resets the conversation title', async ({ app }) => {
    await app.open();
    await app.page.getByTestId('chat-input').fill('hello');
    await app.page.getByTestId('chat-send').click();
    await expect(app.page.locator('#threadTitle')).toHaveText('hello');

    await app.page.locator('#newThreadBtn').click();
    await expect(app.page.locator('#threadTitle')).toHaveText('New chat');
    await expect(app.page.locator('#msgs .msg')).toHaveCount(0);
  });

  test('history button opens the conversations menu', async ({ app }) => {
    await app.open();
    const menu = app.page.locator('#threadMenu');
    await expect(menu).toBeHidden();
    await app.page.locator('#threadsBtn').click();
    await expect(menu).toBeVisible();
  });
});
