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
}

// Qwen2.5-3B-Instruct Q4_K_M — a ~2GB single-file GGUF that runs comfortably on
// 8GB machines. Sourced from a common community GGUF CDN on Hugging Face.
export const BUILTIN_MODEL: BuiltinModelInfo = {
  id: 'qwen2.5-3b-instruct',
  label: 'Qwen2.5 3B Instruct (Q4)',
  uri: 'hf:bartowski/Qwen2.5-3B-Instruct-GGUF:Q4_K_M',
  filePattern: /qwen2\.5-3b-instruct.*q4_k_m.*\.gguf$/i,
  approxSizeBytes: 2_020_000_000,
  contextSize: 4096,
};

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
}

export class LocalModelEngine {
  private readonly modelsDir: string;
  private engineAvailable: boolean | null = null;
  private engineError: string | undefined;
  private downloadState: DownloadState = 'absent';
  private downloadedSize = 0;
  private totalSize = 0;
  private downloadError: string | undefined;
  private downloader: ModelDownloader | null = null;
  private loaded: LoadedModel | null = null;
  private loadPromise: Promise<LoadedModel> | null = null;
  private generateChain: Promise<unknown> = Promise.resolve();

  constructor(modelsDir: string) {
    this.modelsDir = modelsDir;
  }

  async status(): Promise<BuiltinModelStatus> {
    const filePath = await this.findModelFile();
    const present = filePath !== null;
    if (present && this.downloadState !== 'downloading') this.downloadState = 'ready';
    else if (!present && this.downloadState === 'ready') this.downloadState = 'absent';
    return {
      modelId: BUILTIN_MODEL.id,
      label: BUILTIN_MODEL.label,
      approxSizeBytes: BUILTIN_MODEL.approxSizeBytes,
      engineAvailable: await this.checkEngine(),
      ...(this.engineError ? { engineError: this.engineError } : {}),
      present,
      ...(filePath ? { filePath } : {}),
      download: {
        state: this.downloadState,
        downloadedSize: this.downloadedSize,
        totalSize: this.totalSize || BUILTIN_MODEL.approxSizeBytes,
        ...(this.downloadError ? { error: this.downloadError } : {}),
      },
    };
  }

  /**
   * Start (or resume) the model download. Returns immediately with the current
   * status; progress is polled via {@link status}. Safe to call repeatedly.
   */
  async startDownload(): Promise<BuiltinModelStatus> {
    if (this.downloadState === 'downloading') return this.status();
    if (await this.findModelFile()) {
      this.downloadState = 'ready';
      return this.status();
    }
    if (!(await this.checkEngine())) {
      throw new Error(this.engineError || 'The local model engine is not available on this platform');
    }

    this.downloadState = 'downloading';
    this.downloadError = undefined;
    this.downloadedSize = 0;
    this.totalSize = BUILTIN_MODEL.approxSizeBytes;

    // Fire-and-forget: callers poll status via downloadState, so the promise is
    // not retained.
    void (async () => {
      try {
        await mkdir(this.modelsDir, { recursive: true });
        const { createModelDownloader } = await import('node-llama-cpp');
        this.downloader = await createModelDownloader({
          modelUri: BUILTIN_MODEL.uri,
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

    return this.status();
  }

  async cancelDownload(): Promise<BuiltinModelStatus> {
    if (this.downloader) {
      await this.downloader.cancel().catch(() => {});
    }
    if (this.downloadState === 'downloading') this.downloadState = 'absent';
    return this.status();
  }

  async deleteModel(): Promise<BuiltinModelStatus> {
    await this.cancelDownload();
    await this.unload();
    const filePath = await this.findModelFile();
    if (filePath) await rm(filePath, { force: true });
    this.downloadState = 'absent';
    this.downloadedSize = 0;
    return this.status();
  }

  /**
   * Generate a chat reply from the in-process model. The full conversation is
   * replayed on each call (the caller is stateless); generation is serialized
   * because a single context sequence cannot handle concurrent prompts.
   */
  async generateReply(input: {
    system: string;
    messages: Array<{ role: 'user' | 'assistant'; content: string }>;
    timeoutMs?: number;
    maxTokens?: number;
  }): Promise<string> {
    const run = this.generateChain.then(() => this.generateReplyNow(input));
    // Keep the chain alive regardless of this call's outcome.
    this.generateChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async generateReplyNow(input: {
    system: string;
    messages: Array<{ role: 'user' | 'assistant'; content: string }>;
    timeoutMs?: number;
    maxTokens?: number;
  }): Promise<string> {
    const loaded = await this.ensureLoaded();
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

  private async ensureLoaded(): Promise<LoadedModel> {
    if (this.loaded) return this.loaded;
    if (this.loadPromise) return this.loadPromise;

    this.loadPromise = (async () => {
      const filePath = await this.findModelFile();
      if (!filePath) throw new ModelNotDownloadedError(BUILTIN_MODEL.label);
      const { getLlama, LlamaChatSession } = await import('node-llama-cpp');
      const llama = await getLlama();
      const model = await llama.loadModel({ modelPath: filePath });
      const context = await model.createContext({ contextSize: BUILTIN_MODEL.contextSize });
      const session = new LlamaChatSession({ contextSequence: context.getSequence() });
      const loaded: LoadedModel = { llama, model, context, session, filePath };
      this.loaded = loaded;
      return loaded;
    })();

    try {
      return await this.loadPromise;
    } catch (error) {
      this.loadPromise = null;
      throw error;
    } finally {
      // Clear the in-flight promise once settled so a failed load can be retried.
      if (this.loaded) this.loadPromise = null;
    }
  }

  async unload(): Promise<void> {
    const loaded = this.loaded;
    this.loaded = null;
    this.loadPromise = null;
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
  async weightsPresent(): Promise<boolean> {
    return (await this.findModelFile()) !== null;
  }

  private async findModelFile(): Promise<string | null> {
    let entries: string[];
    try {
      entries = await readdir(this.modelsDir);
    } catch {
      return null;
    }
    for (const entry of entries) {
      if (!BUILTIN_MODEL.filePattern.test(entry)) continue;
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
