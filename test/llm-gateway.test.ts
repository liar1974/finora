import { afterEach, describe, expect, it, vi } from 'vitest';
import { clampChatInput, estimateOllamaNumCtx, generateChatReply, LLM_PROVIDERS, providerContextTokens, resolveLlmConfig } from '../src/infrastructure/llm-gateway.js';
import { BUILTIN_MODEL } from '../src/infrastructure/local-model.js';

afterEach(() => vi.unstubAllGlobals());

describe('LLM gateway', () => {
  it('defaults to the key-free built-in local provider', () => {
    const config = resolveLlmConfig(() => null);
    expect(config).toMatchObject({
      provider: 'builtin',
      needsKey: false,
      keySet: true,
      local: true,
      chatModel: BUILTIN_MODEL.id,
    });
    expect(LLM_PROVIDERS.some((provider) => provider.id === 'builtin' && !provider.needsKey && provider.local)).toBe(true);
  });

  it('never routes the built-in model through the HTTP gateway', async () => {
    const config = resolveLlmConfig(() => null);
    await expect(
      generateChatReply({ config, system: 'x', messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toThrow(/built-in local model/i);
  });

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
      options: { num_ctx: 4096 },
    });
  });

  it('sizes Ollama num_ctx to the prompt, bucketed and capped', () => {
    // short prompt → smallest bucket
    expect(estimateOllamaNumCtx('sys', [{ content: 'hi' }], 768, undefined)).toBe(4096);
    // ~60k-char prompt (~17k tokens) → next bucket up
    const big = 'x'.repeat(60_000);
    expect(estimateOllamaNumCtx('', [{ content: big }], 2000, undefined)).toBe(32768);
    // cap wins when the prompt exceeds it
    expect(estimateOllamaNumCtx('', [{ content: 'x'.repeat(200_000) }], 2000, 16384)).toBe(16384);
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

describe('clampChatInput', () => {
  it('leaves input untouched when it fits the context window', () => {
    const input = { system: 'You are helpful.', messages: [{ role: 'user' as const, content: 'Hello' }], maxTokens: 256 };
    const out = clampChatInput(input, 4096);
    expect(out.truncated).toBe(false);
    expect(out.system).toBe(input.system);
    expect(out.messages).toEqual(input.messages);
  });

  it('trims the largest field (middle ellipsis) to fit a small window', () => {
    const big = 'A'.repeat(40_000); // ~11k tokens, far over a 4096 window
    const input = { system: 'System instructions.', messages: [{ role: 'user' as const, content: big }], maxTokens: 768 };
    const out = clampChatInput(input, 4096);
    expect(out.truncated).toBe(true);
    expect(out.system).toBe('System instructions.'); // small field preserved
    const content = out.messages[0]!.content;
    expect(content.length).toBeLessThan(big.length);
    expect(content).toContain('truncated to fit context');
    expect(content.startsWith('A')).toBe(true); // head kept
    expect(content.endsWith('A')).toBe(true);    // tail kept
    // Total estimate now within the 4096-token budget (~ (4096-768-256)*3.5 chars).
    expect(out.system.length + content.length).toBeLessThanOrEqual(Math.floor((4096 - 768 - 256) * 3.5));
  });

  it('does not trim under a large cloud window', () => {
    const input = { system: 's', messages: [{ role: 'user' as const, content: 'x'.repeat(48_000) }], maxTokens: 2000 };
    expect(clampChatInput(input, 128_000).truncated).toBe(false);
  });
});

describe('providerContextTokens', () => {
  it('uses the Ollama num_ctx cap and a large default for cloud', () => {
    const ollama = resolveLlmConfig((k) => ({ LLM_PROVIDER: 'ollama', LLM_NUM_CTX: '65536' })[k] || null);
    expect(providerContextTokens(ollama)).toBe(65536);
    const ollamaDefault = resolveLlmConfig((k) => ({ LLM_PROVIDER: 'ollama' })[k] || null);
    expect(providerContextTokens(ollamaDefault)).toBe(32768);
    const cloud = resolveLlmConfig((k) => ({ LLM_PROVIDER: 'openai', LLM_API_KEY: 'k' })[k] || null);
    expect(providerContextTokens(cloud)).toBe(128_000);
  });
});
