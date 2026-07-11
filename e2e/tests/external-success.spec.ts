import { test, expect } from '../fixtures';

// Success paths for the model- and Telegram-dependent flows, stubbed at the HTTP
// layer with page.route (per-page interception — no network, no server writes,
// safe to run in parallel on the shared main server). These complement the
// graceful-degradation specs (chat.spec, settings-validation.spec) which assert
// the no-model / no-credentials behaviour.

test.describe('model chat (stubbed)', () => {
  test('renders the assistant reply when the model responds', async ({ app }) => {
    await app.page.route('**/v1/chat', (route) =>
      route.fulfill({ json: { reply: 'Your **cash flow** looks healthy.' } }));

    await app.open();
    await app.page.getByTestId('chat-input').fill('how is my cash flow?');
    await app.page.getByTestId('chat-send').click();

    const msgs = app.page.locator('#msgs');
    await expect(msgs.locator('.msg.user')).toContainText('how is my cash flow?');
    // The reply renders as markdown (bold), not a degraded "Model unavailable".
    await expect(msgs.locator('.msg.bot .markdown')).toContainText('cash flow looks healthy');
    await expect(msgs.locator('.msg.bot')).not.toContainText('Model unavailable');
  });
});

test.describe('model test (stubbed)', () => {
  test('"Test model" reports a successful connection', async ({ app }) => {
    // Present a hosted provider as the effective route so the API model form (with
    // its "Test model" button) renders without writing any settings.
    await app.page.route('**/v1/llm', (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      return route.fulfill({
        json: {
          effective: { provider: 'openai', label: 'OpenAI', model: 'gpt-4o', chatModel: 'gpt-4o' },
          providers: [
            { id: 'builtin', label: 'Built-in (local)' },
            { id: 'openai', label: 'OpenAI' },
          ],
          builtinModels: [],
        },
      });
    });
    await app.page.route('**/v1/llm/test', (route) =>
      route.fulfill({ json: { provider: 'OpenAI', model: 'gpt-4o' } }));

    await app.open();
    await app.goto('settings');
    await app.subtab('models').click();

    await app.view.getByRole('button', { name: 'Test model' }).click();
    await expect(app.view).toContainText('Connected: OpenAI / gpt-4o');
    await expect(app.toast).toContainText(/Model connection OK/i);
  });
});

test.describe('telegram connect (stubbed)', () => {
  test('binding a chat succeeds when the bot has a message', async ({ app }) => {
    await app.page.route('**/v1/telegram/connect', (route) =>
      route.fulfill({ json: { chat: { title: 'Finora Test Chat' } } }));

    await app.open();
    await app.goto('settings');
    await app.subtab('delivery').click();

    await app.page.locator('#connectTelegram').click();
    // The connect handler re-renders the tab (wiping its inline message), so the
    // stable success signal is the toast.
    await expect(app.toast).toContainText(/Telegram chat connected/i);
  });
});
