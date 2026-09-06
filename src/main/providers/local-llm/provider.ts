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

/** Thrown by `handle()` when a caller's `expectModelId` (threaded from the
 *  plane's `payload.expectModelId`, itself only present when the caller
 *  passed a `describe()`-derived `generation` — see `inference.ts`'s
 *  `completeWithMeta`) no longer matches the model this provider actually
 *  resolved via `servableModel()`. This closes the window the plane's own
 *  generation check cannot: the plane compares generations right after
 *  `pick()` selects a PROVIDER, but this provider only resolves a MODEL
 *  later, inside its own `handle()` — the model can still change in
 *  between (a completed download, a flipped override) even though the
 *  plane's generation hasn't moved.
 *
 *  Distinct from (not a subclass of) `src/main/core/inference.ts`'s
 *  `ModelChangedError`: that one reports a GENERATION mismatch (two
 *  numbers); this one reports a MODEL-ID mismatch (two strings) — the
 *  plane never had a second generation number to give it, only the model
 *  id it expected. Both are discriminated the same way — by
 *  `name === 'ModelChangedError'`, never `instanceof` — because both cross
 *  the extension RPC boundary (`src/shared/extension-rpc.ts`) via a
 *  process fork, where class identity does not survive. Same field names
 *  (`expected`, `actual`, `modelId`) so a caller-side handler need not care
 *  which side threw. */
export class ModelChangedError extends Error {
  readonly expected: string;

  readonly actual: string;

  readonly modelId: string;

  constructor(expected: string, actual: string) {
    super(
      `the model changed before the request could be sent (expected '${expected}', now '${actual}')`,
    );
    this.name = 'ModelChangedError';
    this.expected = expected;
    this.actual = actual;
    this.modelId = actual;
  }
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
  /** The model id the memoized start was created for — set synchronously
   *  alongside serverStarting so ensureServer can detect a model switch and
   *  restart instead of serving the stale model until idle-stop (which never
   *  comes under steady traffic — every handle() re-arms the timer). */
  let startingModelId: string | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  // `onChange` subscribers + the last model id they were told about.
  // `undefined` means "never observed yet" — set once, synchronously, at
  // construction (see `checkModelChange()`'s first call below) before any
  // caller could possibly have subscribed, so that initial observation
  // never itself counts as a "switch" (mirrors the plane's own "the first
  // registration on an empty plane doesn't bump" rule in `inference.ts`:
  // there is nothing yet to invalidate).
  const changeSubs = new Set<() => void>();
  let lastNotifiedModelId: string | null | undefined;

  // `profile` (issue #107) only means something to `complete` — this
  // provider's `see` request has no decoding-profile concept to apply it
  // to. A caller passing one anyway is not an error (the contract lets any
  // verb accept it and ignore it); log it once per process rather than
  // either silently swallowing it forever or spamming a log line per call.
  let seeProfileIgnoredLogged = false;

  const selectedModel = async (): Promise<ModelDescriptor> => {
    const override = resolveModelOverride(deps.prefs.get().models.override);
    if (override) return override;
    if (!backend) backend = await detect();
    checkModelChange();
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

  /** Re-resolves `servableModel()` and notifies `onChange` subscribers iff
   *  it now differs from the last id they were told about. Called from
   *  every place that mutates an INPUT to `selectedModel`/`servableModel`
   *  (a prefs override change, a completed install, a newly-detected
   *  backend) — not only where a model string is directly assigned — so a
   *  subscriber learns about a switch it could not otherwise observe
   *  without polling `describe()`/`handle()` itself. */
  const checkModelChange = (): void => {
    const id = servableModel()?.id ?? null;
    if (lastNotifiedModelId === undefined) {
      // First observation ever — nothing a subscriber could have held
      // before this point, so it isn't a "switch".
      lastNotifiedModelId = id;
      return;
    }
    if (id === lastNotifiedModelId) return;
    lastNotifiedModelId = id;
    changeSubs.forEach((cb) => cb());
  };

  // Callable after a start has SETTLED: from touchIdle's timer (armed only
  // after a successful start) and from ensureServer's model-switch path
  // (which awaits the in-flight start first, dispose()-style). Never call it
  // with a start still pending — it would clear the memo but leave the
  // spawning child alive to later assign itself to `server` and leak.
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
        checkModelChange();
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

  // Single-flight: the memoized promise is assigned SYNCHRONOUSLY (no `await`
  // between the loop's final memo check and the assignment) so two concurrent
  // first calls can't both slip past a null check and each build+start their
  // own llama-server (the second overwriting `server` and orphaning the first
  // as a leaked multi-GB process). Kept (not cleared) once resolved so later
  // sequential calls reuse it too; stopServer() is the only place that clears
  // it, for a clean restart. On rejection (detect() or s.start() throws), the
  // ownership-guarded catch clears the memo so a retry can attempt a fresh
  // start.
  //
  // Model switch: the memo records which model it was started for
  // (startingModelId). On mismatch — override flipped between two installed
  // models, or an override download completing while the old model serves —
  // settle the in-flight start exactly as dispose() does (so we stop the real
  // child, never race a spawning one into an orphan), then stop it and start
  // fresh. The loop re-checks after every await: a concurrent caller may have
  // already restarted onto the target model (return its memo) or a stop may
  // have cleared the memo entirely (fall through to a fresh start). Any
  // in-flight request on the old server dies with it — the architecture
  // already treats provider crashes as transient DEFER-and-retry faults.
  const ensureServer = async (model: ModelDescriptor): Promise<ServerLike> => {
    for (;;) {
      if (serverStarting && startingModelId === model.id) return serverStarting;
      if (!serverStarting) break;
      const starting = serverStarting;
      await starting.catch(() => {});
      if (serverStarting === starting) await stopServer();
    }
    startingModelId = model.id;
    const starting = (async (): Promise<ServerLike> => {
      const dir = modelDir(deps.modelsDir, model.id);
      const gguf = model.files.find((f) => !f.name.startsWith('mmproj'))!;
      const mmproj = model.files.find((f) => f.name.startsWith('mmproj'))!;
      if (!backend) {
        backend = await detect();
        checkModelChange();
      }
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
  // Establish the onChange baseline synchronously, before returning the
  // provider — so the earliest a subscriber could possibly call `onChange`
  // is strictly after this, and the seeded install never itself reads as
  // a "switch".
  checkModelChange();
  // Reactive path: a prefs write (e.g. the user flips models.override in
  // Settings) is the one INPUT to selectedModel/servableModel that changes
  // from entirely outside this provider's own async flows, so it needs its
  // own subscription rather than a call site inside a function this module
  // owns.
  const offPrefsChange = deps.prefs.onChange(() => checkModelChange());

  return {
    id: 'local-llm',
    // 'hear' moved to the dedicated `local-asr` provider (whisper.cpp): the
    // E-tier mmproj's audio encoder is now unused weight, and `hasAudio`
    // stays on model descriptors purely as documentation. local-llm is the
    // vision/completion path only.
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
    describe() {
      // Ignores `kind`: local-llm serves one model for every kind it
      // supports, and by the time the PLANE calls this, `pick(kind)` has
      // already confirmed this provider supports the kind asked for —
      // there is nothing left here to branch on.
      const model = servableModel();
      return model ? { modelId: model.id } : null;
    },
    onChange(cb) {
      changeSubs.add(cb);
      return () => {
        changeSubs.delete(cb);
      };
    },
    async handle(req) {
      const model = servableModel();
      if (!model)
        throw new Error(
          `local-llm not ready (status: ${JSON.stringify(this.status())})`,
        );
      // Re-check the model identity a caller locked in via `describe()`
      // AFTER this provider has resolved the model it is about to serve,
      // and BEFORE any request reaches it — `payload.expectModelId` is
      // only ever set (by the plane) when the caller passed a `generation`
      // it got from `describe()`. This is the half of issue #107's
      // guarantee the plane cannot provide on its own: the plane's own
      // generation check runs right after it picks a PROVIDER, but this
      // provider resolves its MODEL later, right here — a download
      // completing or an override flipping between those two points would
      // otherwise slip a stale-model request through.
      const { expectModelId } =
        (req.payload as { expectModelId?: string } | undefined) ?? {};
      if (expectModelId !== undefined && expectModelId !== model.id) {
        throw new ModelChangedError(expectModelId, model.id);
      }
      const s = await ensureServer(model);
      touchIdle();
      if (req.kind === 'complete') {
        const { prompt, maxTokens, profile, system } = req.payload as {
          prompt: string;
          maxTokens?: number;
          profile?: 'default' | 'deterministic';
          system?: string;
        };
        return chatText(s.baseUrl(), prompt, { maxTokens, profile, system });
      }
      if (req.kind === 'see') {
        const { image, prompt, mime, profile } = req.payload as {
          image: Uint8Array;
          prompt: string;
          mime?: string;
          profile?: 'default' | 'deterministic';
        };
        // `see` has no decoding profile of its own — accept it, ignore it,
        // never throw (issue #107: "every other provider ignores `profile`
        // explicitly").
        if (profile !== undefined && !seeProfileIgnoredLogged) {
          seeProfileIgnoredLogged = true;
          deps.log('info', "local-llm: 'see' ignores the 'profile' option");
        }
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
      offPrefsChange();
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
