import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateChatReply, resolveLlmConfig } from '../src/infrastructure/llm-gateway.js';

afterEach(() => vi.unstubAllGlobals());

describe('LLM gateway', () => {
  it('normalizes Ollama to its OpenAI-compatible endpoint', () => {
    const values: Record<string, string> = {
      LLM_PROVIDER: 'ollama',
      LLM_BASE_URL: 'http://127.0.0.1:11434/',
      LLM_CHAT_MODEL: 'qwen3.5:9b',
    };
    const config = resolveLlmConfig((key) => values[key] || null);
    expect(config).toMatchObject({
      provider: 'ollama',
      baseUrl: 'http://127.0.0.1:11434/v1',
      chatModel: 'qwen3.5:9b',
      keySet: true,
      local: true,
    });
  });

  it('uses native Ollama chat with thinking disabled', async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      Response.json({ message: { role: 'assistant', content: 'Ollama answer' } }));
    vi.stubGlobal('fetch', fetchMock);
    const config = resolveLlmConfig((key) => ({
      LLM_PROVIDER: 'ollama',
      LLM_BASE_URL: 'http://127.0.0.1:11434',
      LLM_CHAT_MODEL: 'qwen3.5:9b',
    })[key] || null);

    const reply = await generateChatReply({
      config,
      system: 'Answer briefly.',
      messages: [{ role: 'user', content: 'Hello' }],
    });

    expect(reply).toBe('Ollama answer');
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('http://127.0.0.1:11434/api/chat');
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      model: 'qwen3.5:9b',
      think: false,
      stream: false,
    });
  });

  it('uses the configured OpenAI-compatible provider for chat', async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => Response.json({
      id: 'chatcmpl-test',
      object: 'chat.completion',
      created: 1,
      model: 'test-model',
      choices: [{ index: 0, message: { role: 'assistant', content: 'Model answer' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const reply = await generateChatReply({
      config: {
        provider: 'custom',
        label: 'Custom OpenAI-compatible',
        apiKey: '',
        baseUrl: 'https://llm.test/v1',
        model: 'test-model',
        chatModel: 'test-model',
        needsKey: false,
        keySet: true,
        local: false,
      },
      system: 'Answer briefly.',
      messages: [{ role: 'user', content: 'Hello' }],
    });

    expect(reply).toBe('Model answer');
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('https://llm.test/v1/chat/completions');
  });
});
