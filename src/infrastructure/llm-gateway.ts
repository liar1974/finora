import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateText, type LanguageModel, type ModelMessage } from 'ai';
import { BUILTIN_MODEL } from './local-model.js';

export type LlmProviderKind = 'anthropic' | 'openai' | 'google' | 'openai-compatible' | 'builtin';

export interface LlmProvider {
  id: string;
  label: string;
  kind: LlmProviderKind;
  baseUrl?: string;
  needsKey: boolean;
  defaultModel: string;
  defaultChatModel: string;
  local?: boolean;
}

export interface LlmConfig {
  provider: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  chatModel: string;
}

export interface EffectiveLlmConfig extends LlmConfig {
  label: string;
  needsKey: boolean;
  keySet: boolean;
  local: boolean;
  // Upper bound for the Ollama num_ctx we request per call (LLM_NUM_CTX). The actual value is
  // sized to the prompt and capped here, so long prompts (e.g. credit-report parsing) aren't
  // silently truncated to Ollama's small server default, without pinning a huge window for
  // short chats. Undefined → a built-in default cap.
  numCtxMax?: number | undefined;
}

// Model selection is live, and every chat surface calls the same gateway.
export const LLM_PROVIDERS: readonly LlmProvider[] = [
  {
    id: 'builtin',
    label: 'Built-in local model (no API key)',
    kind: 'builtin',
    needsKey: false,
    defaultModel: BUILTIN_MODEL.id,
    defaultChatModel: BUILTIN_MODEL.id,
    local: true,
  },
  {
    id: 'ollama',
    label: 'Ollama (local)',
    kind: 'openai-compatible',
    baseUrl: 'http://127.0.0.1:11434/v1',
    needsKey: false,
    defaultModel: 'qwen3.5:9b',
    defaultChatModel: 'qwen3.5:9b',
    local: true,
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    kind: 'anthropic',
    needsKey: true,
    defaultModel: 'claude-haiku-4-5',
    defaultChatModel: 'claude-sonnet-4-6',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    kind: 'openai',
    needsKey: true,
    defaultModel: 'gpt-4.1-mini',
    defaultChatModel: 'gpt-4.1',
  },
  {
    id: 'google',
    label: 'Google Gemini',
    kind: 'google',
    needsKey: true,
    defaultModel: 'gemini-2.5-flash',
    defaultChatModel: 'gemini-2.5-pro',
  },
  {
    id: 'groq',
    label: 'Groq',
    kind: 'openai-compatible',
    baseUrl: 'https://api.groq.com/openai/v1',
    needsKey: true,
    defaultModel: 'llama-3.1-8b-instant',
    defaultChatModel: 'llama-3.3-70b-versatile',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    kind: 'openai-compatible',
    baseUrl: 'https://openrouter.ai/api/v1',
    needsKey: true,
    defaultModel: 'anthropic/claude-haiku-4-5',
    defaultChatModel: 'anthropic/claude-sonnet-4-6',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    kind: 'openai-compatible',
    baseUrl: 'https://api.deepseek.com/v1',
    needsKey: true,
    defaultModel: 'deepseek-chat',
    defaultChatModel: 'deepseek-chat',
  },
  {
    id: 'mistral',
    label: 'Mistral',
    kind: 'openai-compatible',
    baseUrl: 'https://api.mistral.ai/v1',
    needsKey: true,
    defaultModel: 'mistral-small-latest',
    defaultChatModel: 'mistral-large-latest',
  },
  {
    id: 'xai',
    label: 'xAI',
    kind: 'openai-compatible',
    baseUrl: 'https://api.x.ai/v1',
    needsKey: true,
    defaultModel: 'grok-2-latest',
    defaultChatModel: 'grok-2-latest',
  },
  {
    id: 'custom',
    label: 'Custom OpenAI-compatible',
    kind: 'openai-compatible',
    needsKey: false,
    defaultModel: '',
    defaultChatModel: '',
  },
] as const;

const providersById = new Map(LLM_PROVIDERS.map((provider) => [provider.id, provider]));

export function resolveLlmConfig(getSetting: (key: string) => string | null): EffectiveLlmConfig {
  const providerId = (getSetting('LLM_PROVIDER') || process.env.LLM_PROVIDER || 'builtin').toLowerCase();
  const provider = providersById.get(providerId) || providersById.get('custom')!;
  const configuredBaseUrl = getSetting('LLM_BASE_URL') || process.env.LLM_BASE_URL || provider.baseUrl || '';
  const baseUrl = providerId === 'ollama' ? ollamaCompatibleUrl(configuredBaseUrl) : configuredBaseUrl;
  const apiKey = getSetting('LLM_API_KEY') || process.env.LLM_API_KEY || '';
  return {
    provider: providerId,
    label: provider.label,
    apiKey,
    baseUrl,
    model: getSetting('LLM_MODEL') || process.env.LLM_MODEL || provider.defaultModel,
    chatModel: getSetting('LLM_CHAT_MODEL') || process.env.LLM_CHAT_MODEL || provider.defaultChatModel,
    needsKey: provider.needsKey,
    keySet: !provider.needsKey || Boolean(apiKey),
    local: Boolean(provider.local),
    numCtxMax: parsePositiveInt(getSetting('LLM_NUM_CTX') || process.env.LLM_NUM_CTX),
  };
}

function parsePositiveInt(value: string | null | undefined): number | undefined {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

// Size an Ollama context window to the prompt: estimate tokens (~3.5 chars/token) plus the
// output budget and a margin, then round UP to a bucket so num_ctx stays stable across similar
// requests (Ollama reloads the model when num_ctx changes). Capped by LLM_NUM_CTX (default
// 32768) to bound memory. Prompts larger than the cap fall back to the cap.
export function estimateOllamaNumCtx(
  system: string,
  messages: Array<{ content: string }>,
  maxTokens: number | undefined,
  cap: number | undefined,
): number {
  const chars = system.length + messages.reduce((sum, m) => sum + m.content.length, 0);
  const target = Math.ceil(chars / 3.5) + (maxTokens ?? 768) + 512;
  const buckets = [4096, 8192, 16384, 32768, 65536, 131072];
  const bucketed = buckets.find((b) => b >= target) ?? target;
  const ceiling = cap && cap > 0 ? cap : 32768;
  return Math.min(bucketed, ceiling);
}

// Rough token budget for providers with a large context window (cloud models). We don't know
// each model's exact limit, so this is a generous floor that no normal prompt reaches; the
// clamp only bites pathological inputs. Ollama uses its own num_ctx cap; builtin passes its
// per-prompt context budget in explicitly.
export const CLOUD_CONTEXT_TOKENS = 128_000;

// Tokens of context the active provider can accept for input+output. Builtin isn't handled
// here (it never reaches the gateway) — its caller passes its context budget directly to clampChatInput.
export function providerContextTokens(config: EffectiveLlmConfig): number {
  if (config.provider === 'ollama') return config.numCtxMax && config.numCtxMax > 0 ? config.numCtxMax : 32768;
  return CLOUD_CONTEXT_TOKENS;
}

function middleTruncate(text: string, target: number, marker: string): string {
  if (text.length <= target) return text;
  const head = Math.ceil(target * 0.6);
  const tail = Math.max(0, target - head);
  return text.slice(0, head) + marker + text.slice(text.length - tail);
}

// Provider-agnostic input clamp: keep system + messages within the model's context window so no
// provider silently truncates (Ollama) or hard-errors (builtin) on an oversized prompt. Trims
// the largest content field via a middle ellipsis (preserving head + tail — instructions and
// closing text, or first + last records) until the estimate fits the budget. Pure and testable;
// `truncated` lets the caller log when it fired.
//
// The chat system prompt embeds the local ledger as pretty-printed JSON, which tokenizes DENSER
// than prose (~3 chars/token, sometimes less), so this clamp is deliberately conservative: it
// assumes 3 chars/token. Overestimating tokens is the safe bias here — it trims a little early
// rather than letting a dense prompt overflow the window and hard-error the built-in model on the
// pinned (uncompressible) system message. (estimateOllamaNumCtx keeps its own looser 3.5 ratio,
// where the opposite bias — a slightly larger num_ctx — is the safe one.)
export function clampChatInput(
  input: { system: string; messages: Array<{ role: 'user' | 'assistant'; content: string }>; maxTokens?: number },
  contextTokens: number,
): { system: string; messages: Array<{ role: 'user' | 'assistant'; content: string }>; truncated: boolean } {
  const CHARS_PER_TOKEN = 3.0;
  const budgetChars = Math.max(1024, Math.floor((contextTokens - (input.maxTokens ?? 768) - 256) * CHARS_PER_TOKEN));
  const fields = [input.system, ...input.messages.map((m) => m.content)];
  const total = () => fields.reduce((sum, text) => sum + text.length, 0);
  if (total() <= budgetChars) return { system: input.system, messages: input.messages, truncated: false };

  const MARKER = '\n…[truncated to fit context]…\n';
  const MIN_FIELD = 200;
  let guard = fields.length + 4;
  while (total() > budgetChars && guard-- > 0) {
    let largest = 0;
    for (let i = 1; i < fields.length; i += 1) if (fields[i]!.length > fields[largest]!.length) largest = i;
    const field = fields[largest]!;
    if (field.length <= MIN_FIELD + MARKER.length) break;
    const target = Math.max(MIN_FIELD, field.length - (total() - budgetChars) - MARKER.length);
    fields[largest] = middleTruncate(field, target, MARKER);
  }
  return {
    system: fields[0]!,
    messages: input.messages.map((m, i) => ({ ...m, content: fields[i + 1]! })),
    truncated: true,
  };
}

export async function generateChatReply(input: {
  config: EffectiveLlmConfig;
  system: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  timeoutMs?: number;
  maxTokens?: number;
}): Promise<string> {
  if (input.config.provider === 'builtin') {
    throw new Error('The built-in local model must be generated through the local engine, not the HTTP gateway');
  }
  assertConfigured(input.config);
  if (input.config.provider === 'ollama') return generateOllamaReply(input);
  const signal = AbortSignal.timeout(input.timeoutMs ?? 120_000);
  try {
    const result = await generateText({
      model: buildModel(input.config),
      system: input.system,
      messages: input.messages as ModelMessage[],
      maxOutputTokens: input.maxTokens ?? 768,
      temperature: 0.2,
      abortSignal: signal,
    });
    const text = result.text.trim();
    if (!text) throw new Error('The model returned an empty response');
    return text;
  } catch (error) {
    if (signal.aborted) {
      throw new Error(`The model did not respond within ${Math.round((input.timeoutMs ?? 120_000) / 1_000)} seconds`);
    }
    throw error;
  }
}

async function generateOllamaReply(input: {
  config: EffectiveLlmConfig;
  system: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  timeoutMs?: number;
  maxTokens?: number;
}): Promise<string> {
  const baseUrl = input.config.baseUrl.replace(/\/v\d+\/?$/, '').replace(/\/+$/, '');
  const response = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: input.config.chatModel,
      messages: [
        { role: 'system', content: input.system },
        ...input.messages,
      ],
      stream: false,
      think: false,
      options: {
        temperature: 0.2,
        num_predict: input.maxTokens ?? 768,
        num_ctx: estimateOllamaNumCtx(input.system, input.messages, input.maxTokens, input.config.numCtxMax),
      },
    }),
    signal: AbortSignal.timeout(input.timeoutMs ?? 120_000),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Ollama returned HTTP ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`);
  }
  const body = await response.json() as { message?: { content?: string }; error?: string };
  if (body.error) throw new Error(body.error);
  const text = body.message?.content?.trim();
  if (!text) throw new Error('The model returned an empty response');
  return text;
}

function assertConfigured(config: EffectiveLlmConfig): void {
  if (config.needsKey && !config.apiKey) throw new Error(`${config.label} needs an API key`);
  if (!config.chatModel) throw new Error(`${config.label} needs a chat model`);
  if (config.provider === 'custom' && !config.baseUrl) {
    throw new Error('Custom OpenAI-compatible providers need a base URL');
  }
}

function buildModel(config: EffectiveLlmConfig): LanguageModel {
  const provider = providersById.get(config.provider) || providersById.get('custom')!;
  const model = config.chatModel;
  switch (provider.kind) {
    case 'anthropic':
      return createAnthropic({
        apiKey: config.apiKey,
        ...(config.baseUrl ? { baseURL: normalizeAnthropicUrl(config.baseUrl) } : {}),
      })(model);
    case 'openai':
      return createOpenAI({
        apiKey: config.apiKey,
        ...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
      })(model);
    case 'google':
      return createGoogleGenerativeAI({
        apiKey: config.apiKey,
        ...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
      })(model);
    case 'openai-compatible':
      return createOpenAICompatible({
        name: provider.id,
        baseURL: config.baseUrl,
        ...(config.apiKey ? { apiKey: config.apiKey } : {}),
      })(model);
    case 'builtin':
      throw new Error('The built-in local model is not an AI SDK provider');
  }
}

function ollamaCompatibleUrl(url: string): string {
  const normalized = (url || 'http://127.0.0.1:11434').replace(/\/+$/, '');
  return /\/v\d+$/.test(normalized) ? normalized : `${normalized}/v1`;
}

function normalizeAnthropicUrl(url: string): string {
  const normalized = url.replace(/\/+$/, '');
  return /\/v\d+$/.test(normalized) ? normalized : `${normalized}/v1`;
}
