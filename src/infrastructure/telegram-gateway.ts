export interface TelegramUpdate {
  update_id: number;
  message?: {
    text?: string;
    message_thread_id?: number;
    chat?: { id: number | string; type?: string };
  };
}

interface TelegramResponse<T> {
  ok?: boolean;
  result?: T;
  description?: string;
}

export interface TelegramGatewayOptions {
  getToken(): string | null;
  getChatId(): string | null;
  getLastUpdateId(): number;
  saveLastUpdateId(updateId: number): void;
  onMessage(text: string): Promise<string>;
  apiBaseUrl?: string;
  pollTimeoutSeconds?: number;
  retryDelayMs?: number;
}

const TELEGRAM_MESSAGE_LIMIT = 4_000;

export class TelegramGateway {
  private controller: AbortController | null = null;

  constructor(private readonly options: TelegramGatewayOptions) {}

  start(): boolean {
    if (this.controller || !this.options.getToken() || !this.options.getChatId()) return false;
    this.controller = new AbortController();
    void this.run(this.controller).catch((error: unknown) => {
      if (!this.controller?.signal.aborted) {
        console.warn('Finora Telegram gateway stopped unexpectedly:', errorMessage(error));
      }
    });
    return true;
  }

  stop(): void {
    this.controller?.abort();
    this.controller = null;
  }

  private async run(controller: AbortController): Promise<void> {
    let offset = Math.max(0, this.options.getLastUpdateId() + 1);
    const timeout = this.options.pollTimeoutSeconds ?? 30;
    const retryDelay = this.options.retryDelayMs ?? 2_000;

    // Telegram webhooks and getUpdates are mutually exclusive. Preserve pending
    // updates so a previously configured webhook cannot silently disable chat.
    const initialToken = this.options.getToken();
    if (initialToken) {
      await postTelegram(initialToken, 'deleteWebhook', {
        drop_pending_updates: false,
      }, this.options.apiBaseUrl, controller.signal).catch((error: unknown) => {
        if (!controller.signal.aborted) {
          console.warn('Finora Telegram deleteWebhook failed:', errorMessage(error));
        }
      });
    }

    while (!controller.signal.aborted) {
      const token = this.options.getToken();
      const ownerChatId = this.options.getChatId();
      if (!token || !ownerChatId) break;

      try {
        const url = telegramApiUrl(this.options.apiBaseUrl, token, 'getUpdates');
        url.searchParams.set('offset', String(offset));
        url.searchParams.set('limit', '50');
        url.searchParams.set('timeout', String(timeout));
        url.searchParams.set('allowed_updates', JSON.stringify(['message']));
        const response = await fetch(url, {
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout((timeout + 10) * 1_000),
          ]),
        });
        if (!response.ok) throw new Error(`getUpdates returned HTTP ${response.status}`);
        const body = await response.json() as TelegramResponse<TelegramUpdate[]>;
        if (!body.ok || !body.result) throw new Error(body.description || 'getUpdates failed');

        for (const update of body.result) {
          await this.handleUpdate(update, token, ownerChatId, controller.signal);
          // Acknowledge only after an authorized message has been answered. If
          // delivery fails, a restart/retry may duplicate a reply, but it will
          // not silently lose the user's question.
          offset = Math.max(offset, update.update_id + 1);
          this.options.saveLastUpdateId(update.update_id);
        }
      } catch (error) {
        if (controller.signal.aborted) break;
        console.warn('Finora Telegram getUpdates failed:', errorMessage(error));
        await abortableDelay(retryDelay, controller.signal);
      }
    }

    if (this.controller === controller) this.controller = null;
  }

  private async handleUpdate(
    update: TelegramUpdate,
    token: string,
    ownerChatId: string,
    signal: AbortSignal,
  ): Promise<void> {
    const message = update.message;
    const text = message?.text?.trim();
    const chatId = message?.chat?.id;
    if (!text || chatId === undefined || String(chatId) !== ownerChatId) return;

    await postTelegram(token, 'sendChatAction', {
      chat_id: chatId,
      ...(message?.message_thread_id !== undefined ? { message_thread_id: message.message_thread_id } : {}),
      action: 'typing',
    }, this.options.apiBaseUrl, signal).catch(() => undefined);

    let reply: string;
    try {
      reply = await this.options.onMessage(text);
    } catch (error) {
      console.warn('Finora Telegram message handling failed:', errorMessage(error));
      reply = 'I could not process that message. Please try again.';
    }

    await sendTelegramMessage({
      token,
      chatId: String(chatId),
      text: reply,
      ...(message?.message_thread_id !== undefined ? { messageThreadId: message.message_thread_id } : {}),
      ...(this.options.apiBaseUrl ? { apiBaseUrl: this.options.apiBaseUrl } : {}),
      signal,
    });
  }
}

export async function sendTelegramMessage(input: {
  token: string;
  chatId: string;
  text: string;
  messageThreadId?: number;
  apiBaseUrl?: string;
  signal?: AbortSignal;
}): Promise<void> {
  for (const text of chunkTelegramMessage(input.text)) {
    const response = await postTelegram(input.token, 'sendMessage', {
      chat_id: input.chatId,
      ...(input.messageThreadId !== undefined ? { message_thread_id: input.messageThreadId } : {}),
      text,
      disable_web_page_preview: true,
    }, input.apiBaseUrl, input.signal);
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`sendMessage returned HTTP ${response.status}${body ? `: ${body.slice(0, 200)}` : ''}`);
    }
    const body = await response.json() as TelegramResponse<unknown>;
    if (!body.ok) throw new Error(body.description || 'Telegram could not send the message');
  }
}

export function chunkTelegramMessage(text: string): string[] {
  if (text.length <= TELEGRAM_MESSAGE_LIMIT) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > TELEGRAM_MESSAGE_LIMIT) {
    const window = remaining.slice(0, TELEGRAM_MESSAGE_LIMIT + 1);
    let splitAt = Math.max(window.lastIndexOf('\n\n'), window.lastIndexOf('\n'));
    if (splitAt < TELEGRAM_MESSAGE_LIMIT / 2) splitAt = TELEGRAM_MESSAGE_LIMIT;
    chunks.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function telegramApiUrl(apiBaseUrl: string | undefined, token: string, method: string): URL {
  const base = (apiBaseUrl || process.env.TELEGRAM_API_BASE || 'https://api.telegram.org').replace(/\/+$/, '');
  return new URL(`${base}/bot${token}/${method}`);
}

function postTelegram(
  token: string,
  method: string,
  body: Record<string, unknown>,
  apiBaseUrl?: string,
  signal?: AbortSignal,
): Promise<Response> {
  return fetch(telegramApiUrl(apiBaseUrl, token, method), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(12_000)])
      : AbortSignal.timeout(12_000),
  });
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
