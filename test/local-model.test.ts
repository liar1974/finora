import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BUILTIN_MODEL, LocalModelEngine, ModelNotDownloadedError } from '../src/infrastructure/local-model.js';

describe('LocalModelEngine', () => {
  it('refuses to generate before the weights are downloaded', async () => {
    // A directory that will never hold weights: generation must fail fast with a
    // typed error the service turns into a "download the model" prompt, and must
    // not touch the native runtime.
    const engine = new LocalModelEngine(join(tmpdir(), 'finora-nonexistent-models', String(process.pid)));
    await expect(
      engine.generateReply({ system: 'test', messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toBeInstanceOf(ModelNotDownloadedError);
  });

  it('exposes the built-in model identity used by the gateway default', () => {
    expect(BUILTIN_MODEL.id).toBe('qwen2.5-3b-instruct');
    expect(BUILTIN_MODEL.uri.startsWith('hf:')).toBe(true);
    expect(BUILTIN_MODEL.filePattern.test('Qwen2.5-3B-Instruct-Q4_K_M.gguf')).toBe(true);
  });
});
