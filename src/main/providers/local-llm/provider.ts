import fs from 'fs';
import path from 'path';

import {
  ModelChangedError,
  type InferenceProvider,
  type LogLevel,
  type Prefs,
  type ProviderStatus,
} from '@shared/contracts';

import {
  hostBudget,
  readHostFacts,
  type HostFacts,
  type LlmAccel,
} from '../../core/host-profile';
import { chatText, describeImage, embedTexts } from './api';
import { checkCapability, type CapabilityResult } from './capability';
import { detectHostBackend } from './backend';
import type { BackendInfo } from './backend';
import { downloadModel, modelFilesPresent } from './downloader';
import {
  EMBEDDING_MODEL,
  modelDir,
  resolveModelOverride,
  selectCuratedModel,
} from './models';
import type { ModelDescriptor } from './models';
import { LlamaServer } from './server';
import { createSwapGate } from './swap-gate';

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
  /** The `local-embed` provider: the embedding model on the same server
   *  (register it right after this one). */
  embedProvider: InferenceProvider;
  /** Download the embedding model when Local AI may install models. Boot
   *  calls it once: with the chat model installed nothing else would. */
  ensureEmbedInstalled(): void;
  /** Detected acceleration; null until the first detect(). */
  accel(): LlmAccel | null;
}

/** Leave half the logical cores to the user and stop idle busy-waiting.
 *  NEVER add -np here: an explicit slot count disables llama-server's unified KV
 *  cache and splits the 24k context (see server.ts contextSize). */
export function llamaThreadArgs(host: HostFacts, accel: LlmAccel): string[] {
  const n = String(hostBudget(host, accel).backgroundThreads);
  return ['-t', n, '-tb', n, '--poll', '0'];
}

const DEFAULT_IDLE_STOP_MS = 10 * 60_000;

export function createLocalLlmProvider(deps: {
  /** The build to run: the GPU build when vendored, else the CPU build.
   *  null = no llama-server for this host → the provider is unsupported. */
  llamaBinaryPath: string | null;
  /** The CPU-only build (win32/linux), used when detection says cpu and as
   *  the fallback when the GPU build fails to start. */
  cpuBinaryPath?: string | null;
  /** `llama-server --list-devices` probe for Vulkan detection (non-darwin). */
  listDevices?(): Promise<string>;
  modelsDir: string;
  prefs: Prefs;
  log(level: LogLevel, msg: string): void;
  host?: HostFacts;
  detect?(): Promise<BackendInfo>;
  download?: typeof downloadModel;
  filesPresent?: typeof modelFilesPresent;
  makeServer?(args: {
    binaryPath: string;
    modelPath: string;
    mmprojPath?: string;
    gpuLayers: number;
    embeddings?: boolean;
    extraArgs?: string[];
    log(level: LogLevel, msg: string): void;
  }): ServerLike;
  idleStopMs?: number;
}): LocalLlmProvider {
  const host = deps.host ?? readHostFacts();
  const detect =
    deps.detect ??
    (() =>
      detectHostBackend({
        platform: host.platform,
        totalMemBytes: host.totalMemBytes,
        ...(deps.listDevices ? { listDevices: deps.listDevices } : {}),
      }));
  const download = deps.download ?? downloadModel;
  const filesPresent = deps.filesPresent ?? modelFilesPresent;
  const makeServer =
    deps.makeServer ??
    ((args) => new LlamaServer(args as any) as unknown as ServerLike);
  const idleStopMs = deps.idleStopMs ?? DEFAULT_IDLE_STOP_MS;

  const capability: CapabilityResult = deps.llamaBinaryPath
    ? checkCapability({
        platform: host.platform,
        arch: host.arch,
        totalMemBytes: host.totalMemBytes,
      })
    : { ok: false, reason: 'no_binary' };
  if (!deps.llamaBinaryPath)
    deps.log('warn', '[local-llm] no llama-server build for this host');
  const cpuBinary = deps.cpuBinaryPath ?? null;
  /** The cpu build when detection says cpu (a vulkan build with -ngl 0
   *  would still init Vulkan), else the primary build. */
  const binaryFor = (accel: LlmAccel): string =>
    (accel === 'cpu' ? cpuBinary : null) ?? deps.llamaBinaryPath!;
  let backend: BackendInfo | null = null; // detected once, lazily
  let detecting: Promise<BackendInfo> | null = null;
  /** One probe per provider; its result never replaces a backend already
   *  set (the cpu fallback after a failed vulkan start stays put). */
  const detectOnce = (): Promise<BackendInfo> => {
    if (backend) return Promise.resolve(backend);
    detecting ??= detect().then(
      (b) => {
        backend ??= b;
        return backend;
      },
      (err) => {
        detecting = null;
        throw err;
      },
    );
    return detecting;
  };
  let installedModel: ModelDescriptor | null = null; // model whose files are on disk
  /** One download's state; the chat model and the embedding model each
   *  have their own, so neither download changes the other's status. */
  interface Tracker {
    pct: number | null;
    error: string | null;
    abort: AbortController | null;
  }
  const chatT: Tracker = { pct: null, error: null, abort: null };
  const embedT: Tracker = { pct: null, error: null, abort: null };
  const gate = createSwapGate();
  let server: ServerLike | null = null;
  let serverStarting: Promise<ServerLike> | null = null;
  /** The model id the memoized start was created for — set synchronously
   *  alongside serverStarting so ensureServer can detect a model switch and
   *  restart instead of serving the stale model until idle-stop (which never
   *  comes under steady traffic — every handle() re-arms the timer). */
  let startingModelId: string | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  // `onChange` subscribers + the last model id they were told about. No
  // "first observation doesn't count" special case is needed: the baseline
  // `checkModelChange()` call below (right after construction seeds
  // `installedModel`) always runs before this function RETURNS the object
  // that exposes `onChange` — no subscriber can possibly exist yet at that
  // point, so `changeSubs.forEach` is a no-op on the first call regardless
  // of what `lastNotifiedModelId` starts as. (Fix round, post-review: an
  // earlier version had an explicit `undefined`-sentinel guard here; a
  // mutation check showed removing it changed no test's outcome — it was
  // dead weight guarding against something structurally impossible, not a
  // real behavior. Simpler now: `null` means "no model", plain and simple.)
  const changeSubs = new Set<() => void>();
  let lastNotifiedModelId: string | null = null;

  // `profile` (issue #107) only means something to `complete` — this
  // provider's `see` request has no decoding-profile concept to apply it
  // to. A caller passing one anyway is not an error (the contract lets any
  // verb accept it and ignore it); log it once per process rather than
  // either silently swallowing it forever or spamming a log line per call.
  let seeProfileIgnoredLogged = false;

  const selectedModel = async (): Promise<ModelDescriptor> => {
    const override = resolveModelOverride(deps.prefs.get().models.override);
    if (override) return override;
    const b = await detectOnce();
    checkModelChange();
    return selectCuratedModel(b);
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
    if (id === lastNotifiedModelId) return;
    lastNotifiedModelId = id;
    changeSubs.forEach((cb) => cb());
  };

  /** Stop the running child. Callable only after the start that created it
   *  has SETTLED (a still-spawning child would later assign itself to
   *  `server` and leak). Leaves the memo alone: the caller owns it. */
  const stopChild = async (): Promise<void> => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
    const s = server;
    server = null;
    if (s)
      await s
        .stop()
        .catch((err) => deps.log('warn', `llama stop: ${String(err)}`));
  };

  /** The last idle/shutdown stop; a fresh start waits for it, so a request
   *  arriving mid-stop never runs a second child beside the stopping one. */
  let stopping: Promise<void> = Promise.resolve();
  /** Set by dispose(): nothing starts a server or a download after it. */
  let disposed = false;

  /** Idle release / shutdown: forget the memo, then stop the child. */
  const stopServer = (): Promise<void> => {
    serverStarting = null;
    // Starts at once (the child is detached from `server` synchronously);
    // a later start waits for every stop still running.
    const p = stopChild();
    stopping = Promise.all([stopping, p]).then(
      () => {},
      () => {},
    );
    // Settles only when EVERY stop has (dispose must not return while an
    // earlier idle stop is still shutting a child down).
    return stopping;
  };

  const touchIdle = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    // Only the memo current now may be idle-stopped: a model switch that
    // replaced it owns the stop itself.
    const memo = serverStarting;
    idleTimer = setTimeout(() => {
      if (serverStarting !== memo) return;
      deps.log('info', 'local-llm idle — releasing model RAM');
      void stopServer();
    }, idleStopMs);
    (idleTimer as any).unref?.();
  };

  /** Download `resolve()`'s model into its dir under `t`'s state, then
   *  `done(model)`. Only this run's own finally resets `t` — an aborted run
   *  settling late (after cancelInstall() and a fresh install) must not
   *  clobber the newer run's in-flight state. */
  const install = (
    t: Tracker,
    resolve: () => Promise<ModelDescriptor>,
    done: (model: ModelDescriptor) => void,
  ): void => {
    const abort = new AbortController();
    t.abort = abort;
    // Published SYNCHRONOUSLY, before the first await, so a renderer that
    // refreshes right after clicking Install sees `{downloading}` and starts
    // its poll loop rather than a transient `standby`.
    t.pct = 0;
    t.error = null;
    void (async () => {
      try {
        const model = await resolve();
        const dest = modelDir(deps.modelsDir, model.id);
        if (!filesPresent(model, dest)) {
          deps.log(
            'info',
            `downloading ${model.id} (${model.files.reduce((n, f) => n + f.sizeBytes, 0)} bytes)`,
          );
          await download(model, dest, {
            signal: abort.signal,
            onProgress: (received, total) => {
              if (t.abort === abort) {
                t.pct = total > 0 ? (received / total) * 100 : 0;
              }
            },
          });
        }
        // A run cancelled or disposed while downloading never "finishes".
        if (t.abort === abort && !abort.signal.aborted) done(model);
        deps.log('info', `${model.id} ready`);
      } catch (err) {
        if (!abort.signal.aborted && t.abort === abort) {
          t.error = String(err instanceof Error ? err.message : err);
          deps.log('warn', `model install failed: ${t.error}`);
        }
      } finally {
        if (t.abort === abort) {
          t.pct = null;
          t.abort = null;
        }
      }
    })();
  };

  const embedPresent = (): boolean =>
    filesPresent(EMBEDDING_MODEL, modelDir(deps.modelsDir, EMBEDDING_MODEL.id));

  const ensureEmbedInstalled = (): void => {
    if (disposed || embedT.abort || !capability.ok) return;
    if (!deps.prefs.get().models.autoInstall || embedPresent()) return;
    // Never touches installedModel: the embedding model is not a chat model.
    install(
      embedT,
      async () => EMBEDDING_MODEL,
      () => {},
    );
  };

  const ensureInstalled = (): void => {
    if (disposed || chatT.abort) return;
    if (!capability.ok) return;
    if (!deps.prefs.get().models.autoInstall) return;
    // Override-aware: only skip when the SELECTED model is already installed.
    // A different installed model must not suppress the selected download.
    if (selectedInstalled()) {
      ensureEmbedInstalled();
      return;
    }
    install(chatT, selectedModel, (model) => {
      installedModel = model;
      checkModelChange();
      ensureEmbedInstalled();
    });
  };

  // Single-flight over the WHOLE switch: the memo is replaced
  // synchronously by a promise that first settles and stops the previous
  // server, then starts `model` — so every concurrent caller awaits the same
  // promise and two llama-server children never overlap (each holds GBs).
  // Kept once resolved so later calls reuse it; cleared on rejection so a
  // retry can start fresh, and by stopServer() (idle release / dispose).
  //
  // A switch (chat ↔ embed, or an override flip) stops the old child. The
  // swap gate guarantees chat and embed are never in flight together, so a
  // chat ↔ embed switch never kills a request; an override flip under load
  // still does, as before (a transient, deferred-and-retried fault).
  const ensureServer = (
    model: ModelDescriptor,
    embeddings = false,
  ): Promise<ServerLike> => {
    if (serverStarting && startingModelId === model.id) return serverStarting;
    const previous = serverStarting;
    startingModelId = model.id;
    const starting = (async (): Promise<ServerLike> => {
      if (previous) {
        await previous.catch(() => {});
        await stopChild();
      }
      await stopping;
      if (disposed) throw new Error('local-llm is shut down');
      const dir = modelDir(deps.modelsDir, model.id);
      const gguf = model.files.find((f) => !f.name.startsWith('mmproj'))!;
      const mmproj = model.files.find((f) => f.name.startsWith('mmproj'));
      const firstDetect = !backend;
      const { accel } = await detectOnce();
      if (firstDetect) checkModelChange();
      const launch = (as: LlmAccel): ServerLike =>
        makeServer({
          binaryPath: binaryFor(as),
          modelPath: path.join(dir, gguf.name),
          ...(mmproj ? { mmprojPath: path.join(dir, mmproj.name) } : {}),
          gpuLayers: as === 'cpu' ? 0 : 999,
          ...(embeddings ? { embeddings: true } : {}),
          extraArgs: llamaThreadArgs(host, as),
          log: deps.log,
        });
      let s = launch(accel);
      try {
        await s.start();
      } catch (err) {
        // A Vulkan build that can't start (no driver, a broken GPU) must not
        // take local AI down when a CPU build is vendored: run on cpu from
        // now on. darwin has no separate cpu build.
        if (accel !== 'vulkan' || !cpuBinary || disposed) throw err;
        deps.log(
          'warn',
          `[local-llm] vulkan llama-server failed to start (${String(
            (err as Error)?.message ?? err,
          )}); using the cpu build`,
        );
        backend = { accel: 'cpu', capacityBytes: host.totalMemBytes };
        checkModelChange();
        s = launch('cpu');
        await s.start();
      }
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

  const embedProvider: InferenceProvider = {
    id: 'local-embed',
    supports: ['embed'],
    status(): ProviderStatus {
      if (!capability.ok) return 'unsupported';
      if (embedT.pct !== null) return { downloading: { pct: embedT.pct } };
      if (embedT.error) return { error: embedT.error };
      return embedPresent() ? 'ready' : 'standby';
    },
    mayBecomeReady() {
      if (!capability.ok || embedPresent()) return false;
      return (
        embedT.pct !== null ||
        (embedT.error === null && deps.prefs.get().models.autoInstall)
      );
    },
    describe: () => (embedPresent() ? { modelId: EMBEDDING_MODEL.id } : null),
    async handle(req) {
      if (req.kind !== 'embed')
        throw new Error(`local-embed does not support '${req.kind}'`);
      const release = await gate.enter('embed', req.lane);
      try {
        const s = await ensureServer(EMBEDDING_MODEL, true);
        touchIdle();
        return await embedTexts(
          s.baseUrl(),
          (req.payload as { texts: string[] }).texts,
        );
      } finally {
        release();
      }
    },
  };

  return {
    id: 'local-llm',
    // 'hear' moved to the dedicated `local-asr` provider (whisper.cpp): the
    // E-tier mmproj's audio encoder is now unused weight, and `hasAudio`
    // stays on model descriptors purely as documentation. local-llm is the
    // vision/completion path only.
    supports: ['complete', 'see'],
    accel: () => backend?.accel ?? null,
    status(): ProviderStatus {
      if (!capability.ok) return 'unsupported';
      if (chatT.pct !== null) return { downloading: { pct: chatT.pct } };
      if (chatT.error) return { error: chatT.error };
      // Ready iff the SELECTED model is installed. When the selected model
      // isn't installed we report `standby` (which lets ensureInstalled
      // trigger its download) even though a previously-installed fallback
      // model could still SERVE via handle — a coherent split: status tracks
      // the user's chosen model, handle stays available in the meantime.
      if (selectedInstalled()) return 'ready';
      return 'standby';
    },
    mayBecomeReady() {
      if (!capability.ok || selectedInstalled()) return false;
      return (
        chatT.pct !== null ||
        (chatT.error === null && deps.prefs.get().models.autoInstall)
      );
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
      // it got from `describe()`, and (post fix-round) carries what that
      // earlier call recorded, not a value freshly recomputed at call
      // time (see `inference.ts`'s `describedAt` map) — recomputing fresh
      // would make this comparison always pass, since both reads happen in
      // the same synchronous JS turn with nothing able to mutate state in
      // between.
      //
      // The PLANE's own generation check (`checkGeneration`, run before
      // this provider is even asked to resolve a model) is the primary
      // guarantee: it already rejects any call whose generation moved,
      // and every real model change in THIS provider bumps the generation
      // via `onChange` (below). This check is the BACKSTOP for the one
      // case that guarantee can't cover on its own — a bug where some
      // future mutation to `selectedModel`/`servableModel`'s inputs is
      // added without a matching `checkModelChange()` call, so the model
      // drifts without the generation counter moving. It is not a second,
      // independent closer of the describe()-to-handle() race.
      const { expectModelId, generation } =
        (req.payload as
          | { expectModelId?: string; generation?: number }
          | undefined) ?? {};
      if (expectModelId !== undefined && expectModelId !== model.id) {
        throw new ModelChangedError(
          generation ?? -1,
          generation ?? -1,
          model.id,
          'model-drift',
        );
      }
      // Held until the request SETTLES (hence `return await` below): the
      // gate is what keeps an embed swap from killing this request.
      const release = await gate.enter('chat', req.lane);
      try {
        const s = await ensureServer(model);
        touchIdle();
        if (req.kind === 'complete') {
          const {
            prompt,
            maxTokens,
            profile,
            system,
            schema,
            grammar,
            topLogprobs,
          } = req.payload as {
            prompt: string;
            maxTokens?: number;
            profile?: 'default' | 'deterministic';
            system?: string;
            schema?: Record<string, unknown>;
            grammar?: string;
            topLogprobs?: number;
          };
          return await chatText(s.baseUrl(), prompt, {
            maxTokens,
            profile,
            system,
            schema,
            grammar,
            topLogprobs,
          });
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
          return await describeImage(s.baseUrl(), image, prompt, { mime });
        }
        throw new Error(`local-llm does not support '${req.kind}'`);
      } finally {
        release();
      }
    },
    ensureInstalled,
    ensureEmbedInstalled,
    embedProvider,
    async cancelInstall() {
      for (const t of [chatT, embedT]) {
        t.abort?.abort();
        t.abort = null;
        t.pct = null;
        t.error = null;
      }
    },
    async dispose() {
      disposed = true;
      // App shutdown: abort any in-flight install and stop the llama-server
      // child so it doesn't outlive the app (up to the 10-min idle window).
      // Deliberately does NOT touch prefs.autoInstall — quitting is not the
      // user disabling auto-install (that flip lives in the Settings 'Cancel'
      // IPC handler), so a pending download resumes on next launch. Reuses the
      // ownership-token reset that cancelInstall relies on.
      for (const t of [chatT, embedT]) {
        t.abort?.abort();
        t.abort = null;
        t.pct = null;
      }
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
