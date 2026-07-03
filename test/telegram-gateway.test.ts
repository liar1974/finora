import { afterEach, describe, expect, it, vi } from 'vitest';
import { TelegramGateway, chunkTelegramMessage } from '../src/infrastructure/telegram-gateway.js';

afterEach(() => vi.unstubAllGlobals());

describe('TelegramGateway', () => {
  it('long-polls from the persisted offset and answers only the bound chat', async () => {
    const posts: Array<{ method: string; body: Record<string, unknown> }> = [];
    let getUpdatesCalls = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = url.pathname.split('/').at(-1)!;
      if (method === 'getUpdates') {
        getUpdatesCalls += 1;
        if (getUpdatesCalls === 1) {
          expect(url.searchParams.get('offset')).toBe('41');
          return Response.json({
            ok: true,
            result: [
              { update_id: 41, message: { text: 'How much cash?', chat: { id: 123, type: 'private' } } },
              { update_id: 42, message: { text: 'Ignore me', chat: { id: 999, type: 'private' } } },
            ],
          });
        }
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
        });
      }
      posts.push({ method, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return Response.json({ ok: true, result: {} });
    });
    vi.stubGlobal('fetch', fetchMock);

    const handled: string[] = [];
    const saved: number[] = [];
    const gateway = new TelegramGateway({
      getToken: () => 'token',
      getChatId: () => '123',
      getLastUpdateId: () => 40,
      saveLastUpdateId: (id) => saved.push(id),
      onMessage: async (text) => {
        handled.push(text);
        return 'You have $100 in cash.';
      },
      apiBaseUrl: 'https://telegram.test',
      pollTimeoutSeconds: 1,
      retryDelayMs: 1,
    });

    expect(gateway.start()).toBe(true);
    await vi.waitFor(() => expect(posts.some((post) => post.method === 'sendMessage')).toBe(true));
    gateway.stop();

    expect(handled).toEqual(['How much cash?']);
    expect(saved).toEqual([41, 42]);
    expect(posts.find((post) => post.method === 'sendMessage')?.body).toMatchObject({
      chat_id: '123',
      text: 'You have $100 in cash.',
    });
  });

  it('splits replies below Telegram message limits', () => {
    const chunks = chunkTelegramMessage(`${'a'.repeat(3_900)}\n\n${'b'.repeat(3_900)}`);
    expect(chunks).toHaveLength(2);
    expect(chunks.every((part) => part.length <= 4_000)).toBe(true);
    expect(chunks.join('\n\n')).toContain('b'.repeat(100));
  });

  it('does not acknowledge an update when reply delivery fails', async () => {
    const saved: number[] = [];
    let gateway: TelegramGateway;
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const method = new URL(String(input)).pathname.split('/').at(-1)!;
      if (method === 'getUpdates') {
        return Response.json({
          ok: true,
          result: [{ update_id: 9, message: { text: 'Question', chat: { id: 123 } } }],
        });
      }
      if (method === 'sendMessage') {
        gateway.stop();
        return new Response('temporary failure', { status: 503 });
      }
      return Response.json({ ok: true, result: {} });
    });
    vi.stubGlobal('fetch', fetchMock);

    gateway = new TelegramGateway({
      getToken: () => 'token',
      getChatId: () => '123',
      getLastUpdateId: () => 8,
      saveLastUpdateId: (id) => saved.push(id),
      onMessage: async () => 'Answer',
      apiBaseUrl: 'https://telegram.test',
      pollTimeoutSeconds: 1,
      retryDelayMs: 1,
    });

    gateway.start();
    await vi.waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/sendMessage'))).toBe(true));
    expect(saved).toEqual([]);
  });
});
