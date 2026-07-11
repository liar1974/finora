import { describe, expect, it } from 'vitest';
import {
  BUILTIN_MODEL,
  BUILTIN_MODELS,
  contextCeiling,
  estimateBuiltinContextSize,
  getBuiltinModel,
  ModelNotDownloadedError,
} from '../src/infrastructure/local-model.js';
import { missingModelEngine } from './helpers.js';

describe('LocalModelEngine', () => {
  it('refuses to generate before the weights are downloaded', async () => {
    // A directory that will never hold weights: generation must fail fast with a
    // typed error the service turns into a "download the model" prompt, and must
    // not touch the native runtime.
    const engine = missingModelEngine();
    await expect(
      engine.generateReply({ system: 'test', messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toBeInstanceOf(ModelNotDownloadedError);
  });

  it('exposes the built-in model identity used by the gateway default', () => {
    expect(BUILTIN_MODEL.id).toBe('qwen3.5-4b');
    expect(BUILTIN_MODEL.uri.startsWith('hf:')).toBe(true);
    // node-llama-cpp saves HF downloads as hf_<user>_<repo>.<quant>.gguf, so the
    // pattern must match that on-disk form, not just the repo's original filename.
    expect(BUILTIN_MODEL.filePattern.test('hf_bartowski_Qwen_Qwen3.5-4B.Q4_K_M.gguf')).toBe(true);
  });

  it('resolves a model by id and falls back to the default for unknown/empty ids', () => {
    // The default (BUILTIN_MODEL) is the first catalog entry.
    expect(getBuiltinModel()).toBe(BUILTIN_MODEL);
    expect(getBuiltinModel(null)).toBe(BUILTIN_MODEL);
    expect(getBuiltinModel('does-not-exist')).toBe(BUILTIN_MODEL);
    const gemma = BUILTIN_MODELS.find((model) => model.id === 'gemma3-1b')!;
    expect(getBuiltinModel('gemma3-1b')).toBe(gemma);
  });

  it('reports the status of every catalog model as absent when no weights exist', async () => {
    const statuses = await missingModelEngine().statusAll();
    expect(statuses.map((status) => status.modelId)).toEqual(BUILTIN_MODELS.map((model) => model.id));
    // Nothing is downloaded in the throwaway dir, so every model reports absent.
    expect(statuses.every((status) => status.present === false)).toBe(true);
    expect(statuses.every((status) => status.download.state === 'absent')).toBe(true);
  });

  it('falls back to the static ceiling for contextBudget when the model cannot load', async () => {
    // With no weights the trained window is unknown, so the budget the gateway
    // clamps chat input to is the configured ceiling rather than throwing.
    expect(await missingModelEngine().contextBudget()).toBe(contextCeiling(BUILTIN_MODEL));
  });
});

describe('contextCeiling', () => {
  it('defaults to the model ceiling and is overridden (clamped) by FINORA_BUILTIN_CONTEXT', () => {
    expect(contextCeiling(BUILTIN_MODEL, {})).toBe(BUILTIN_MODEL.maxContextSize);
    // A power user can raise it above the default, up to the hard max.
    expect(contextCeiling(BUILTIN_MODEL, { FINORA_BUILTIN_CONTEXT: '65536' })).toBe(65536);
    expect(contextCeiling(BUILTIN_MODEL, { FINORA_BUILTIN_CONTEXT: '999999' })).toBe(131072);
    // A constrained machine can lower it; garbage falls back to the default.
    expect(contextCeiling(BUILTIN_MODEL, { FINORA_BUILTIN_CONTEXT: '4096' })).toBe(4096);
    expect(contextCeiling(BUILTIN_MODEL, { FINORA_BUILTIN_CONTEXT: '10' })).toBe(2048); // floored
    expect(contextCeiling(BUILTIN_MODEL, { FINORA_BUILTIN_CONTEXT: 'nonsense' })).toBe(BUILTIN_MODEL.maxContextSize);
  });
});

// The character-based fallback used only when no live tokenizer is available; the
// primary path tokenizes for real (see sizeContextForPrompt). The ratio is deliberately
// low (2.0 chars/token) so it over-allocates rather than overflowing a dense prompt.
describe('estimateBuiltinContextSize', () => {
  it('buckets small prompts low so the KV cache is not over-allocated', () => {
    // A tiny prompt needs only the smallest bucket, not the model's full window.
    expect(estimateBuiltinContextSize('You are helpful.', [{ content: 'hi' }], 256, 32768)).toBe(2048);
  });

  it('grows the bucket as the prompt grows, and never exceeds the ceiling', () => {
    // ~30k chars at the conservative 2.0 chars/token ≈ 15k tokens + output/margin → 16384 bucket.
    const big = 'x'.repeat(30_000);
    expect(estimateBuiltinContextSize(big, [{ content: 'go' }], 768, 32768)).toBe(16384);
    // An enormous prompt is capped at the provided ceiling rather than a bigger bucket.
    const huge = 'x'.repeat(500_000);
    expect(estimateBuiltinContextSize(huge, [{ content: 'go' }], 768, 8192)).toBe(8192);
  });
});
