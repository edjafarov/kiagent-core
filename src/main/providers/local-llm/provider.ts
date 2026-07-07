import fs from 'fs';
import path from 'path';

import type {
  InferenceProvider,
  LogLevel,
  Prefs,
  ProviderStatus,
} from '@shared/contracts';

import { chatText, describeImage } from './api';
import { checkCapability, readHostProbes } from './capability';
import { detectHostBackend } from './backend';
import type { BackendInfo } from './backend';
import { downloadModel, modelFilesPresent } from './downloader';
import { modelDir, resolveModelOverride, selectCuratedModel } from './models';
import type { ModelDescriptor } from './models';
import { LlamaServer } from './server';

export interface ServerLike {
  start(): Promise<void>;
  stop(): Promise<void>;
  baseUrl(): string;
}

export interface LocalLlmProvider extends InferenceProvider {
  ensureInstalled(): void;
  cancelInstall(): Promise<void>;
  /** App-shutdown cleanup: stop the llama-server child and abort any in-flight
   *  install WITHOUT disabling the autoInstall pref. */
  dispose(): Promise<void>;
  selectedModel(): Promise<ModelDescriptor>;
  installedModelIds(): string[];
}

const DEFAULT_IDLE_STOP_MS = 10 * 60_000;

export function createLocalLlmProvider(deps: {
  llamaBinaryPath: string;
  modelsDir: string;
  prefs: Prefs;
  log(level: LogLevel, msg: string): void;
  detect?(): Promise<BackendInfo>;
  download?: typeof downloadModel;
  filesPresent?: typeof modelFilesPresent;
  makeServer?(args: {
    binaryPath: string;
    modelPath: string;
    mmprojPath: string;
    gpuLayers: number;
    log(level: LogLevel, msg: string): void;
  }): ServerLike;
  idleStopMs?: number;
}): LocalLlmProvider {
  const detect = deps.detect ?? (() => detectHostBackend());
  const download = deps.download ?? downloadModel;
  const filesPresent = deps.filesPresent ?? modelFilesPresent;
  const makeServer =
    deps.makeServer ??
    ((args) => new LlamaServer(args as any) as unknown as ServerLike);
  const idleStopMs = deps.idleStopMs ?? DEFAULT_IDLE_STOP_MS;

  const capability = checkCapability(readHostProbes());
  let backend: BackendInfo | null = null; // detected once, lazily
  let installedModel: ModelDescriptor | null = null; // model whose files are on disk
  let downloadPct: number | null = null;
  let lastError: string | null = null;
  let installing: AbortController | null = null;
  let server: ServerLike | null = null;
  let serverStarting: Promise<ServerLike> | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const selectedModel = async (): Promise<ModelDescriptor> => {
    const override = resolveModelOverride(deps.prefs.get().models.override);
    if (override) return override;
    if (!backend) backend = await detect();
    return selectCuratedModel(backend);
  };

  const modelPresent = (m: ModelDescriptor): boolean =>
    filesPresent(m, modelDir(deps.modelsDir, m.id));

  /** The SELECTED model, resolved synchronously when possible: the override
   *  is a sync prefs read; the auto tier needs `backend` (detected lazily on
   *  the first ensureInstalled/handle). null = auto tier, backend not yet
   *  detected — the model can't be named this instant. */
  const selectedModelSync = (): ModelDescriptor | null => {
    const override = resolveModelOverride(deps.prefs.get().models.override);
    if (override) return override;
    if (backend) return selectCuratedModel(backend);
    return null;
  };

  /** Scan the models dir for ANY resolvable, fully-present model. */
  const scanInstalled = (): ModelDescriptor | null => {
    if (!fs.existsSync(deps.modelsDir)) return null;
    for (const id of fs.readdirSync(deps.modelsDir)) {
      const m = resolveModelOverride(id);
      if (m && modelPresent(m)) return m;
    }
    return null;
  };

  /** Is the SELECTED model installed on disk? Drives status readiness and
   *  whether ensureInstalled downloads. When the selected model can't be
   *  named yet (auto tier, no backend), fall back to the seeded/scanned
   *  install so a fresh process over an existing model still reports ready
   *  without paying a detect(). */
  const selectedInstalled = (): ModelDescriptor | null => {
    const sel = selectedModelSync();
    if (sel) return modelPresent(sel) ? sel : null;
    if (installedModel && modelPresent(installedModel)) return installedModel;
    return scanInstalled();
  };

  /** The model `handle` should serve: the selected one when it's installed,
   *  else ANY installed model as a fallback while the selected one downloads
   *  (never deletes the already-installed model). */
  const servableModel = (): ModelDescriptor | null => {
    const sel = selectedInstalled();
    if (sel) return sel;
    if (installedModel && modelPresent(installedModel)) return installedModel;
    return scanInstalled();
  };

  // Only callable after a successful first start (idle timer armed in touchIdle),
  // so `server` is never null mid-first-start when this executes.
  const stopServer = async (): Promise<void> => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
    const s = server;
    server = null;
    serverStarting = null;
    if (s)
      await s
        .stop()
        .catch((err) => deps.log('warn', `llama stop: ${String(err)}`));
  };

  const touchIdle = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      deps.log('info', 'local-llm idle — releasing model RAM');
      void stopServer();
    }, idleStopMs);
    (idleTimer as any).unref?.();
  };

  const ensureInstalled = (): void => {
    if (installing) return;
    if (!capability.ok) return;
    if (!deps.prefs.get().models.autoInstall) return;
    // Override-aware: only skip when the SELECTED model is already installed.
    // A different installed model must not suppress the selected download.
    if (selectedInstalled()) return;
    const abort = new AbortController();
    installing = abort;
    // Publish the downloading state SYNCHRONOUSLY, before the first await, so
    // a renderer that refreshes immediately after clicking Install sees
    // `{downloading}` and starts its poll loop rather than catching a
    // transient `standby` while selectedModel()/detect() resolves. We're
    // committed to a download here — the selected model isn't installed.
    downloadPct = 0;
    lastError = null;
    void (async () => {
      try {
        const model = await selectedModel();
        const dest = modelDir(deps.modelsDir, model.id);
        if (!filesPresent(model, dest)) {
          deps.log(
            'info',
            `downloading ${model.id} (${model.files.reduce((n, f) => n + f.sizeBytes, 0)} bytes)`,
          );
          await download(model, dest, {
            signal: abort.signal,
            onProgress: (received, total) => {
              if (installing === abort) {
                downloadPct = total > 0 ? (received / total) * 100 : 0;
              }
            },
          });
        }
        installedModel = model;
        deps.log('info', `${model.id} ready`);
      } catch (err) {
        if (!abort.signal.aborted && installing === abort) {
          lastError = String(err instanceof Error ? err.message : err);
          deps.log('warn', `model install failed: ${lastError}`);
        }
      } finally {
        // Only this run's own finally may reset the shared install state —
        // otherwise an aborted run settling late (after cancelInstall() and
        // a fresh ensureInstalled()) clobbers the newer run's in-flight state.
        if (installing === abort) {
          downloadPct = null;
          installing = null;
        }
      }
    })();
  };

  // Single-flight: the memoized promise is assigned SYNCHRONOUSLY (before any
  // `await`) so two concurrent first calls can't both slip past a null check
  // and each build+start their own llama-server (the second overwriting
  // `server` and orphaning the first as a leaked multi-GB process). Kept
  // (not cleared) once resolved so later sequential calls reuse it too;
  // stopServer() is the only place that clears it, for a clean restart.
  // On rejection (detect() or s.start() throws), the ownership-guarded catch
  // clears the memo so a retry can attempt a fresh start.
  const ensureServer = (model: ModelDescriptor): Promise<ServerLike> => {
    if (serverStarting) return serverStarting;
    const starting = (async (): Promise<ServerLike> => {
      const dir = modelDir(deps.modelsDir, model.id);
      const gguf = model.files.find((f) => !f.name.startsWith('mmproj'))!;
      const mmproj = model.files.find((f) => f.name.startsWith('mmproj'))!;
      if (!backend) backend = await detect();
      const s = makeServer({
        binaryPath: deps.llamaBinaryPath,
        modelPath: path.join(dir, gguf.name),
        mmprojPath: path.join(dir, mmproj.name),
        gpuLayers: backend.accel === 'cpu' ? 0 : 999,
        log: deps.log,
      });
      await s.start();
      server = s;
      return s;
    })();
    serverStarting = starting;
    starting.catch(() => {
      if (serverStarting === starting) serverStarting = null;
    });
    return starting;
  };

  const seedInstalled = (): void => {
    if (!fs.existsSync(deps.modelsDir)) return;
    const ids = fs.readdirSync(deps.modelsDir);
    for (const id of ids) {
      const m = resolveModelOverride(id);
      if (m && filesPresent(m, modelDir(deps.modelsDir, id))) {
        installedModel = m;
        return;
      }
    }
  };

  seedInstalled();

  return {
    id: 'local-llm',
    supports: ['complete', 'see'],
    status(): ProviderStatus {
      if (!capability.ok) return 'unsupported';
      if (downloadPct !== null) return { downloading: { pct: downloadPct } };
      if (lastError) return { error: lastError };
      // Ready iff the SELECTED model is installed. When the selected model
      // isn't installed we report `standby` (which lets ensureInstalled
      // trigger its download) even though a previously-installed fallback
      // model could still SERVE via handle — a coherent split: status tracks
      // the user's chosen model, handle stays available in the meantime.
      if (selectedInstalled()) return 'ready';
      return 'standby';
    },
    async handle(req) {
      const model = servableModel();
      if (!model)
        throw new Error(
          `local-llm not ready (status: ${JSON.stringify(this.status())})`,
        );
      const s = await ensureServer(model);
      touchIdle();
      if (req.kind === 'complete') {
        const { prompt, maxTokens } = req.payload as {
          prompt: string;
          maxTokens?: number;
        };
        return chatText(s.baseUrl(), prompt, { maxTokens });
      }
      if (req.kind === 'see') {
        const { image, prompt, mime } = req.payload as {
          image: Uint8Array;
          prompt: string;
          mime?: string;
        };
        return describeImage(s.baseUrl(), image, prompt, { mime });
      }
      throw new Error(`local-llm does not support '${req.kind}'`);
    },
    ensureInstalled,
    async cancelInstall() {
      installing?.abort();
      installing = null;
      downloadPct = null;
      lastError = null;
    },
    async dispose() {
      // App shutdown: abort any in-flight install and stop the llama-server
      // child so it doesn't outlive the app (up to the 10-min idle window).
      // Deliberately does NOT touch prefs.autoInstall — quitting is not the
      // user disabling auto-install (that flip lives in the Settings 'Cancel'
      // IPC handler), so a pending download resumes on next launch. Reuses the
      // ownership-token reset that cancelInstall relies on.
      installing?.abort();
      installing = null;
      downloadPct = null;
      // Let any in-flight server start settle first, so we stop the real child
      // rather than racing it into an orphan (the start's IIFE assigns
      // `server` only once s.start() resolves).
      const starting = serverStarting;
      if (starting) await starting.catch(() => {});
      await stopServer();
    },
    selectedModel,
    installedModelIds() {
      if (!fs.existsSync(deps.modelsDir)) return [];
      return fs.readdirSync(deps.modelsDir).filter((id) => {
        const m = resolveModelOverride(id);
        return m !== null && filesPresent(m, modelDir(deps.modelsDir, id));
      });
    },
  };
}
