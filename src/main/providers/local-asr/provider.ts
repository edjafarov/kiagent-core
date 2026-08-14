import os from 'node:os';
import path from 'node:path';
import { promises as fsp } from 'node:fs';

import type {
  InferenceProvider,
  LogLevel,
  Prefs,
  ProviderStatus,
} from '@shared/contracts';

import { downloadModel, modelFilesPresent } from '../local-llm/downloader';
import { modelDir } from '../local-llm/models';
import type { ModelDescriptor } from '../local-llm/models';
import { checkAsrCapability } from './capability';
import { asrAccel, selectAsrModel } from './models';
import { runWhisperCli } from './whisper-cli';

export interface LocalAsrProvider extends InferenceProvider {
  ensureInstalled(): void;
  cancelInstall(): Promise<void>;
  dispose(): Promise<void>;
  /** Bundled-only file-path route (never on WorkerSession/CapSurfaces). */
  transcribeFile(p: string, opts: { format: 'wav' | 'mp3' }): Promise<string>;
}

interface QueuedJob {
  run(): Promise<void>;
  reject(e: Error): void;
}

export function createLocalAsrProvider(deps: {
  binaryPath: string;
  /** <dataDir>/models/asr — its OWN base for the shared modelDir helper. */
  asrModelsDir: string;
  prefs: Prefs;
  log(level: LogLevel, msg: string): void;
  probes?: { platform: NodeJS.Platform; totalMemBytes: number };
  download?: typeof downloadModel;
  filesPresent?: typeof modelFilesPresent;
  runCli?: typeof runWhisperCli;
  binaryPresent?: (p: string) => boolean;
}): LocalAsrProvider {
  const download = deps.download ?? downloadModel;
  const filesPresent = deps.filesPresent ?? modelFilesPresent;
  const runCli = deps.runCli ?? runWhisperCli;
  const probes = deps.probes ?? {
    platform: process.platform,
    totalMemBytes: os.totalmem(),
  };
  const capability = checkAsrCapability(deps.binaryPath, deps.binaryPresent);
  // Whisper tiering is fully sync (no async accel detect like llama's):
  // platform decides metal-vs-cpu, RAM decides the tier. Resolved once.
  const model: ModelDescriptor = selectAsrModel({
    accel: asrAccel(probes.platform),
    totalMemBytes: probes.totalMemBytes,
  });

  let downloadPct: number | null = null;
  let lastError: string | null = null;
  let installing: AbortController | null = null;
  let closing = false;

  const installed = (): boolean =>
    filesPresent(model, modelDir(deps.asrModelsDir, model.id));

  // ── single-flight ─────────────────────────────────────────────────────────
  // One whisper-cli at a time: a second concurrent request queues rather than
  // loading the model twice (the single-slot convention llama-server already
  // imposes). dispose() rejects the QUEUE too — killing only the active child
  // is not enough, because before-quit disposes providers BEFORE
  // platform.shutdown() stops the workers, and a queued request would
  // otherwise take the freed slot and spawn a fresh child after disposal.
  const queue: QueuedJob[] = [];
  let busy = false;
  let active: AbortController | null = null;
  /** The in-flight job's settlement, so dispose() can AWAIT the child it just
   *  signalled instead of racing the wrapper's SIGTERM→SIGKILL escalation. */
  let activeRun: Promise<void> | null = null;

  const pump = (): void => {
    if (busy) return;
    const job = queue.shift();
    if (!job) return;
    busy = true;
    const run = job.run().finally(() => {
      busy = false;
      if (activeRun === run) activeRun = null;
      pump();
    });
    // Assigned before the `finally` callback can run (it is a microtask), so
    // dispose() never observes a null activeRun for a job that is still going.
    activeRun = run;
  };

  const transcribeFile = (
    p: string,
    _opts: { format: 'wav' | 'mp3' },
  ): Promise<string> =>
    new Promise<string>((resolve, reject) => {
      if (closing) {
        reject(new Error('local-asr disposed — app quitting'));
        return;
      }
      queue.push({
        reject,
        async run() {
          if (closing) {
            reject(new Error('local-asr disposed — app quitting'));
            return;
          }
          if (!installed()) {
            reject(new Error('local-asr model not installed'));
            return;
          }
          const abort = new AbortController();
          active = abort;
          try {
            const text = await runCli({
              binaryPath: deps.binaryPath,
              modelPath: path.join(
                modelDir(deps.asrModelsDir, model.id),
                model.files[0].name,
              ),
              inputPath: p,
              signal: abort.signal,
            });
            resolve(text);
          } catch (err) {
            // Pass the original through unchanged — an AsrInputRejectedError
            // must stay instanceof for the worker's terminal-skip branch.
            reject(err instanceof Error ? err : new Error(String(err)));
          } finally {
            if (active === abort) active = null;
          }
        },
      });
      pump();
    });

  const ensureInstalled = (): void => {
    if (installing) return;
    if (closing) return;
    if (!capability.ok) return;
    if (!deps.prefs.get().models.autoInstall) return;
    if (installed()) return;
    const abort = new AbortController();
    installing = abort;
    // Publish downloading SYNCHRONOUSLY (before the first await) so a renderer
    // refreshing right after Install sees {downloading} and starts polling —
    // same contract as local-llm's ensureInstalled.
    downloadPct = 0;
    lastError = null;
    void (async () => {
      try {
        const dest = modelDir(deps.asrModelsDir, model.id);
        deps.log(
          'info',
          `downloading ${model.id} (${model.files[0].sizeBytes} bytes)`,
        );
        await download(model, dest, {
          signal: abort.signal,
          onProgress: (received, total) => {
            if (installing === abort) {
              downloadPct = total > 0 ? (received / total) * 100 : 0;
            }
          },
        });
        deps.log('info', `${model.id} ready`);
      } catch (err) {
        if (!abort.signal.aborted && installing === abort) {
          lastError = String(err instanceof Error ? err.message : err);
          deps.log('warn', `asr model install failed: ${lastError}`);
        }
      } finally {
        // Only this run's own finally may reset the shared install state —
        // otherwise an aborted run settling late (after cancelInstall() and a
        // fresh ensureInstalled()) clobbers the newer run's in-flight state.
        if (installing === abort) {
          downloadPct = null;
          installing = null;
        }
      }
    })();
  };

  return {
    id: 'local-asr',
    supports: ['hear'],
    status(): ProviderStatus {
      if (!capability.ok) return 'unsupported';
      if (downloadPct !== null) return { downloading: { pct: downloadPct } };
      if (lastError) return { error: lastError };
      if (installed()) return 'ready';
      return 'standby';
    },
    async handle(req) {
      if (req.kind !== 'hear') {
        throw new Error(`local-asr does not support '${req.kind}'`);
      }
      // The PUBLIC hear seam stays byte-based (extensions reach it through
      // CapSurfaces — a path API there would be an arbitrary-file-read hole).
      // Extension audio payloads are small; write to a temp file and delegate.
      const { audio, format } = req.payload as {
        audio: Uint8Array;
        format?: 'wav' | 'mp3';
      };
      // ALLOWLIST, never sanitize. The `'wav' | 'mp3'` annotation is erased at
      // runtime: InferenceProvider.handle takes `payload: unknown` and the
      // extension RPC forwards caller arguments verbatim, so a third-party
      // extension can send any string. Interpolating it into a path would
      // hand it an arbitrary-file WRITE-and-DELETE primitive (path.join
      // normalizes `..`, and the finally below removes what it created) —
      // strictly worse than the arbitrary-file READ this byte seam exists to
      // prevent.
      const fmt: 'wav' | 'mp3' = format === 'mp3' ? 'mp3' : 'wav';
      // mkdtemp gives a fresh 0700 directory, so the file name is no longer
      // guessable and cannot be pre-planted as a symlink; `wx` + mode 0600
      // close the last of that race and keep private audio unreadable to
      // other users on a shared /tmp.
      const dir = await fsp.mkdtemp(
        path.join(os.tmpdir(), 'kiagent-asr-hear-'),
      );
      try {
        const tmp = path.join(dir, `audio.${fmt}`);
        await fsp.writeFile(tmp, audio, { mode: 0o600, flag: 'wx' });
        return await transcribeFile(tmp, { format: fmt });
      } finally {
        await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    },
    ensureInstalled,
    async cancelInstall() {
      installing?.abort();
      installing = null;
      downloadPct = null;
      lastError = null;
    },
    async dispose() {
      // (1) permanent closing flag, (2) reject every queued waiter and any
      // later call, (3) kill the in-flight child (SIGTERM→SIGKILL via the
      // wrapper's abort handling). Does NOT touch prefs.autoInstall —
      // quitting is not opting out (that flip lives in the Cancel IPC).
      closing = true;
      installing?.abort();
      installing = null;
      downloadPct = null;
      while (queue.length > 0) {
        queue.shift()!.reject(new Error('local-asr disposed — app quitting'));
      }
      active?.abort();
      // (4) AWAIT the signalled job. abort() dispatches SIGTERM synchronously,
      // but the SIGKILL escalation lives on a 2s unref'd timer inside the
      // wrapper — resolving now would let before-quit finish teardown first
      // and the escalation would simply never be sent. Awaiting bounds the
      // wait at ~2s and makes SIGKILL reachable by construction, the same
      // shape as LlamaServer.stop() awaiting its child's 'exit'.
      const run = activeRun;
      if (run) await run.catch(() => {});
    },
    transcribeFile,
  };
}
