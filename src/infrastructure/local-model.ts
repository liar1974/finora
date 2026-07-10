import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  ChatHistoryItem,
  Llama,
  LlamaChatSession as LlamaChatSessionType,
  LlamaContext,
  LlamaModel,
  ModelDownloader,
} from 'node-llama-cpp';

// The built-in provider ships the llama.cpp engine (via node-llama-cpp's
// prebuilt binaries) but NOT the weights — those download from a public model
// CDN (Hugging Face) on first use into the user's data directory. This lets a
// first-time user chat with a local model without an API key and without
// installing Ollama.

export interface BuiltinModelInfo {
  id: string;
  label: string;
  /** Hugging Face model URI understood by node-llama-cpp's downloader. */
  uri: string;
  /** Regex matching the on-disk .gguf filename, used for offline presence checks. */
  filePattern: RegExp;
  /** Approximate download size in bytes, shown before the real size is known. */
  approxSizeBytes: number;
  contextSize: number;
  /**
   * Whether this is a reasoning model that emits a <think> block (Qwen3.5). When
   * true, chain-of-thought is kept on for real generation (planning can improve
   * answers/extraction); when false the model answers directly (Gemma 3). The
   * connectivity test always turns thinking off regardless — see generateReply.
   */
  thinking: boolean;
}

// The selectable built-in models. All are single-file Q4_K_M GGUFs from a common
// community CDN on Hugging Face. The first entry is the default (smallest, runs
// comfortably on 8GB machines); larger entries trade memory for quality.
export const BUILTIN_MODELS: readonly BuiltinModelInfo[] = [
  {
    id: 'qwen3.5-4b',
    label: 'Qwen3.5 4B (Q4)',
    uri: 'hf:bartowski/Qwen_Qwen3.5-4B-GGUF:Q4_K_M',
    filePattern: /qwen3\.5-4b.*q4_k_m.*\.gguf$/i,
    approxSizeBytes: 3_010_000_000,
    contextSize: 4096,
    thinking: true,
  },
  {
    id: 'qwen3.5-9b',
    label: 'Qwen3.5 9B (Q4)',
    uri: 'hf:bartowski/Qwen_Qwen3.5-9B-GGUF:Q4_K_M',
    filePattern: /qwen3\.5-9b.*q4_k_m.*\.gguf$/i,
    approxSizeBytes: 6_170_000_000,
    contextSize: 4096,
    thinking: true,
  },
  {
    id: 'gemma3-1b',
    label: 'Gemma 3 1B (Q4)',
    uri: 'hf:bartowski/google_gemma-3-1b-it-GGUF:Q4_K_M',
    filePattern: /gemma-3-1b-it.*q4_k_m.*\.gguf$/i,
    approxSizeBytes: 810_000_000,
    contextSize: 4096,
    thinking: false,
  },
  {
    id: 'gemma3-4b',
    label: 'Gemma 3 4B (Q4)',
    uri: 'hf:bartowski/google_gemma-3-4b-it-GGUF:Q4_K_M',
    filePattern: /gemma-3-4b-it.*q4_k_m.*\.gguf$/i,
    approxSizeBytes: 2_490_000_000,
    contextSize: 4096,
    thinking: false,
  },
  {
    id: 'gemma3-12b',
    label: 'Gemma 3 12B (Q4)',
    uri: 'hf:bartowski/google_gemma-3-12b-it-GGUF:Q4_K_M',
    filePattern: /gemma-3-12b-it.*q4_k_m.*\.gguf$/i,
    approxSizeBytes: 7_300_000_000,
    contextSize: 4096,
    thinking: false,
  },
] as const;

// The default built-in model (used by the gateway when no model is configured).
export const BUILTIN_MODEL: BuiltinModelInfo = BUILTIN_MODELS[0]!;

/** Resolve a built-in model descriptor by id, falling back to the default. */
export function getBuiltinModel(id?: string | null): BuiltinModelInfo {
  if (!id) return BUILTIN_MODEL;
  return BUILTIN_MODELS.find((model) => model.id === id) ?? BUILTIN_MODEL;
}

export type DownloadState = 'absent' | 'downloading' | 'ready' | 'error';

export interface BuiltinModelStatus {
  modelId: string;
  label: string;
  approxSizeBytes: number;
  engineAvailable: boolean;
  engineError?: string;
  present: boolean;
  filePath?: string;
  download: {
    state: DownloadState;
    downloadedSize: number;
    totalSize: number;
    error?: string;
  };
}

export class ModelNotDownloadedError extends Error {
  readonly code = 'model_not_downloaded';
  constructor(label: string) {
    super(`The built-in model (${label}) has not been downloaded yet. Download it in Settings → Models.`);
    this.name = 'ModelNotDownloadedError';
  }
}

interface LoadedModel {
  llama: Llama;
  model: LlamaModel;
  context: LlamaContext;
  session: LlamaChatSessionType;
  filePath: string;
  modelId: string;
}

export class LocalModelEngine {
  private readonly modelsDir: string;
  private engineAvailable: boolean | null = null;
  private engineError: string | undefined;
  // Only one download runs at a time; these track that single active download and
  // which model it belongs to. Presence of any other model is read from disk.
  private downloadState: DownloadState = 'absent';
  private downloadedSize = 0;
  private totalSize = 0;
  private downloadError: string | undefined;
  private downloadingModelId: string | null = null;
  private downloader: ModelDownloader | null = null;
  private loaded: LoadedModel | null = null;
  private loadPromise: Promise<LoadedModel> | null = null;
  private loadPromiseModelId: string | null = null;
  private generateChain: Promise<unknown> = Promise.resolve();

  constructor(modelsDir: string) {
    this.modelsDir = modelsDir;
  }

  async status(modelId?: string): Promise<BuiltinModelStatus> {
    const model = getBuiltinModel(modelId);
    const filePath = await this.findModelFile(model);
    const present = filePath !== null;
    const active = this.downloadingModelId === model.id;

    let state: DownloadState;
    if (active && this.downloadState === 'downloading') state = 'downloading';
    else if (present) state = 'ready';
    else if (active && this.downloadState === 'error') state = 'error';
    else state = 'absent';

    return {
      modelId: model.id,
      label: model.label,
      approxSizeBytes: model.approxSizeBytes,
      engineAvailable: await this.checkEngine(),
      ...(this.engineError ? { engineError: this.engineError } : {}),
      present,
      ...(filePath ? { filePath } : {}),
      download: {
        state,
        downloadedSize: active ? this.downloadedSize : present ? model.approxSizeBytes : 0,
        totalSize: active && this.totalSize ? this.totalSize : model.approxSizeBytes,
        ...(active && this.downloadError ? { error: this.downloadError } : {}),
      },
    };
  }

  /** Status of every selectable built-in model (drives the Settings dropdown). */
  async statusAll(): Promise<BuiltinModelStatus[]> {
    return Promise.all(BUILTIN_MODELS.map((model) => this.status(model.id)));
  }

  /**
   * Start (or resume) a model download. Returns immediately with the current
   * status; progress is polled via {@link status}. Safe to call repeatedly.
   */
  async startDownload(modelId?: string): Promise<BuiltinModelStatus> {
    const model = getBuiltinModel(modelId);
    if (this.downloadState === 'downloading' && this.downloadingModelId === model.id) return this.status(model.id);
    if (await this.findModelFile(model)) return this.status(model.id);
    if (!(await this.checkEngine())) {
      throw new Error(this.engineError || 'The local model engine is not available on this platform');
    }

    this.downloadingModelId = model.id;
    this.downloadState = 'downloading';
    this.downloadError = undefined;
    this.downloadedSize = 0;
    this.totalSize = model.approxSizeBytes;

    // Fire-and-forget: callers poll status via downloadState, so the promise is
    // not retained.
    void (async () => {
      try {
        await mkdir(this.modelsDir, { recursive: true });
        const { createModelDownloader } = await import('node-llama-cpp');
        this.downloader = await createModelDownloader({
          modelUri: model.uri,
          dirPath: this.modelsDir,
          skipExisting: true,
          onProgress: ({ totalSize, downloadedSize }) => {
            this.totalSize = totalSize || this.totalSize;
            this.downloadedSize = downloadedSize;
          },
        });
        this.totalSize = this.downloader.totalSize || this.totalSize;
        await this.downloader.download();
        this.downloadedSize = this.totalSize;
        this.downloadState = 'ready';
      } catch (error) {
        this.downloadState = 'error';
        this.downloadError = error instanceof Error ? error.message : String(error);
      } finally {
        this.downloader = null;
      }
    })();

    return this.status(model.id);
  }

  async cancelDownload(modelId?: string): Promise<BuiltinModelStatus> {
    if (this.downloader) {
      await this.downloader.cancel().catch(() => {});
    }
    if (this.downloadState === 'downloading') this.downloadState = 'absent';
    this.downloadingModelId = null;
    return this.status(modelId);
  }

  async deleteModel(modelId?: string): Promise<BuiltinModelStatus> {
    const model = getBuiltinModel(modelId);
    if (this.downloadingModelId === model.id) await this.cancelDownload(model.id);
    if (this.loaded?.modelId === model.id) await this.unload();
    const filePath = await this.findModelFile(model);
    if (filePath) await rm(filePath, { force: true });
    if (this.downloadingModelId === model.id) {
      this.downloadState = 'absent';
      this.downloadedSize = 0;
      this.downloadingModelId = null;
    }
    return this.status(model.id);
  }

  /**
   * Keep only the given model on disk: delete every other built-in model's
   * weights (and cancel any stray download). Called after a model is SAVED as the
   * active one (a successful download), so at most one large GGUF is retained while
   * still letting the user download a second model to try before committing.
   * The dropdown still lists the deleted models (they just show as re-downloadable).
   */
  async pruneOtherModels(keepModelId?: string): Promise<void> {
    const keep = getBuiltinModel(keepModelId).id;
    for (const model of BUILTIN_MODELS) {
      if (model.id === keep) continue;
      if (this.downloadingModelId === model.id || (await this.weightsPresent(model.id))) {
        await this.deleteModel(model.id);
      }
    }
  }

  /**
   * Generate a chat reply from the in-process model. The full conversation is
   * replayed on each call (the caller is stateless); generation is serialized
   * because a single context sequence cannot handle concurrent prompts.
   */
  async generateReply(
    input: {
      system: string;
      messages: Array<{ role: 'user' | 'assistant'; content: string }>;
      timeoutMs?: number;
      maxTokens?: number;
      disableThinking?: boolean;
    },
    modelId?: string,
  ): Promise<string> {
    const run = this.generateChain.then(() => this.generateReplyNow(input, modelId));
    // Keep the chain alive regardless of this call's outcome.
    this.generateChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async generateReplyNow(
    input: {
      system: string;
      messages: Array<{ role: 'user' | 'assistant'; content: string }>;
      timeoutMs?: number;
      maxTokens?: number;
      disableThinking?: boolean;
    },
    modelId?: string,
  ): Promise<string> {
    const model = getBuiltinModel(modelId);
    const loaded = await this.ensureLoaded(model);
    const messages = input.messages;
    const lastUserIndex = findLastUserIndex(messages);
    if (lastUserIndex === -1) throw new Error('A user message is required to generate a reply');

    const history: ChatHistoryItem[] = [];
    if (input.system.trim()) history.push({ type: 'system', text: input.system });
    for (let i = 0; i < lastUserIndex; i += 1) {
      const message = messages[i];
      if (!message) continue;
      if (message.role === 'user') history.push({ type: 'user', text: message.content });
      else history.push({ type: 'model', response: [message.content] });
    }
    loaded.session.setChatHistory(history);

    const prompt = messages[lastUserIndex]?.content ?? '';
    const signal = AbortSignal.timeout(input.timeoutMs ?? 120_000);
    try {
      const text = (
        await loaded.session.prompt(prompt, {
          maxTokens: input.maxTokens ?? 768,
          temperature: 0.2,
          // Reasoning models (Qwen3.5, thinking: true) emit a <think> block before
          // answering; keep it ON for real generation, where planning can improve
          // answers/extraction. Turn it off (thoughtTokens: 0) when the model isn't a
          // reasoning model, or when the caller asks — e.g. the connectivity test,
          // where a small maxTokens would otherwise be spent entirely inside <think>
          // and yield an empty response.
          ...(input.disableThinking || !model.thinking ? { budgets: { thoughtTokens: 0 } } : {}),
          signal,
        })
      ).trim();
      if (!text) throw new Error('The model returned an empty response');
      return text;
    } catch (error) {
      if (signal.aborted) {
        throw new Error(
          `The model did not respond within ${Math.round((input.timeoutMs ?? 120_000) / 1_000)} seconds`,
        );
      }
      throw error;
    }
  }

  private async ensureLoaded(model: BuiltinModelInfo): Promise<LoadedModel> {
    if (this.loaded && this.loaded.modelId === model.id) return this.loaded;
    // A different model is already loaded — free it before loading the new one.
    if (this.loaded && this.loaded.modelId !== model.id) await this.unload();
    if (this.loadPromise && this.loadPromiseModelId === model.id) return this.loadPromise;

    this.loadPromiseModelId = model.id;
    this.loadPromise = (async () => {
      const filePath = await this.findModelFile(model);
      if (!filePath) throw new ModelNotDownloadedError(model.label);
      const { getLlama, LlamaChatSession } = await import('node-llama-cpp');
      const llama = await getLlama();
      const loadedModel = await llama.loadModel({ modelPath: filePath });
      const context = await loadedModel.createContext({ contextSize: model.contextSize });
      const session = new LlamaChatSession({ contextSequence: context.getSequence() });
      const loaded: LoadedModel = { llama, model: loadedModel, context, session, filePath, modelId: model.id };
      this.loaded = loaded;
      return loaded;
    })();

    try {
      return await this.loadPromise;
    } catch (error) {
      this.loadPromise = null;
      this.loadPromiseModelId = null;
      throw error;
    } finally {
      // Clear the in-flight promise once settled so a failed load can be retried.
      if (this.loaded) {
        this.loadPromise = null;
        this.loadPromiseModelId = null;
      }
    }
  }

  async unload(): Promise<void> {
    const loaded = this.loaded;
    this.loaded = null;
    this.loadPromise = null;
    this.loadPromiseModelId = null;
    if (!loaded) return;
    await loaded.context.dispose().catch(() => {});
    await loaded.model.dispose().catch(() => {});
  }

  private async checkEngine(): Promise<boolean> {
    if (this.engineAvailable !== null) return this.engineAvailable;
    try {
      const { getLlama } = await import('node-llama-cpp');
      await getLlama();
      this.engineAvailable = true;
    } catch (error) {
      this.engineAvailable = false;
      this.engineError = error instanceof Error ? error.message : String(error);
    }
    return this.engineAvailable;
  }

  // Cheap presence check: whether downloaded weights exist, without loading the
  // native engine (which status() does via checkEngine, and which is expensive to
  // import on a hot path). Callers that only need "can we try to run the model"
  // should use this rather than status().
  async weightsPresent(modelId?: string): Promise<boolean> {
    return (await this.findModelFile(getBuiltinModel(modelId))) !== null;
  }

  private async findModelFile(model: BuiltinModelInfo): Promise<string | null> {
    let entries: string[];
    try {
      entries = await readdir(this.modelsDir);
    } catch {
      return null;
    }
    for (const entry of entries) {
      if (!model.filePattern.test(entry)) continue;
      const filePath = join(this.modelsDir, entry);
      try {
        const info = await stat(filePath);
        // A completed weights file is far larger than any partial/temp stub.
        if (info.isFile() && info.size > 100 * 1024 * 1024) return filePath;
      } catch {
        // Ignore unreadable entries.
      }
    }
    return null;
  }
}

function findLastUserIndex(messages: Array<{ role: 'user' | 'assistant'; content: string }>): number {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === 'user') return i;
  }
  return -1;
}
