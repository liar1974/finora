import { describe, expect, it } from 'vitest';
import { BUILTIN_MODEL, BUILTIN_MODELS, getBuiltinModel, ModelNotDownloadedError } from '../src/infrastructure/local-model.js';
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
});
