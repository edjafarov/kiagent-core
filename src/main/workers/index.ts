import type { Handle, Worker } from '@shared/contracts';

import {
  attachWorker,
  backgroundAdmits,
  backgroundLaneOpen,
} from '../core/boot';
import type { CorePlatform } from '../core/boot';
import { workerConsumerName } from '../core/engine/engine';
import type { VisionHelper } from '../providers/apple-vision/vision-helper';
import type { LocalAsrProvider } from '../providers/local-asr';
import type { LocalLlmProvider } from '../providers/local-llm/provider';
import { createAudioWorker } from './audio/audio-worker';
import { createConvertWorker } from './convert/convert-worker';
import type { ImageDownscaler } from './vision/downscale';
import { VISION_WORKER } from './vision/identity';
import { pickRasterizer } from './vision/rasterize';
import { createVisionWorker } from './vision/vision-worker';

/** The vision worker's ledger consumer ("worker:vision:v1"). */
export const VISION_CONSUMER = workerConsumerName(VISION_WORKER);

export function attachBundledWorkers(
  platform: CorePlatform,
  deps: {
    visionHelper: VisionHelper | null;
    localLlm: LocalLlmProvider;
    localAsr: LocalAsrProvider;
    /** Absent in tests / non-Electron hosts — the worker falls back to a
     *  pass-through, i.e. today's behaviour. */
    downscale?: ImageDownscaler;
  },
): Handle {
  // The parse stage: bytes-less attachments (Gmail) get the same converter
  // local files get at commit time. Plain attachWorker — its re-drive only
  // retries docs whose source was still registering, and parsing needs no
  // inference, so it is not held to the processing window.
  const convertWorker = createConvertWorker({ converter: platform.converter });
  attachWorker(platform, convertWorker);
  // The parser is the same on every device.
  platform.lentWork.register(convertWorker, () => ({
    ready: true,
    can: [],
    now: [],
  }));

  const worker = createVisionWorker({
    rasterizer: pickRasterizer(
      deps.visionHelper,
      process.platform,
      platform.converter,
    ),
    // A busy device still starts vision work a helper will answer.
    laneOpen: () => backgroundAdmits(platform, VISION_KINDS),
    downscale: deps.downscale,
    parsePdfPages: (bytes, signal) =>
      platform.converter.parsePdfPages(bytes, signal),
    foregroundIdle: (signal) => platform.admission.foregroundIdle(signal),
  });
  const handle = platform.engine.attach(worker);
  platform.lentWork.register(worker, () => {
    const now: string[] = [];
    const can: string[] = [];
    for (const f of platform.inference.fitness()) {
      if (f.kind !== 'read' && f.kind !== 'see') continue;
      if (f.local === 'ready') now.push(f.kind);
      if (f.local !== 'none') can.push(f.kind);
    }
    return { ready: now.length > 0, can, now };
  });
  // NOT boot.attachWorker: the re-drive job additionally (1) skips outside
  // the processing window and (2) triggers the model auto-install when
  // deferred vision work exists — the user-approved auto-download path.
  registerRedrive(platform, worker, [deps.localLlm]);

  // The audio transcription worker runs the SAME lifecycle over its own
  // consumer/cursor. Its handle is discarded like vision's — shutdown stops
  // every attached worker via engine.stopAll().
  const audioWorker = createAudioWorker({
    totalMemBytes: platform.host.totalMemBytes,
    laneOpen: () => backgroundLaneOpen(platform),
    foregroundIdle: (signal) => platform.admission.foregroundIdle(signal),
    // Demand-driven: every audio candidate asks for the install, so the
    // download runs during the closed processing window (spec §5).
    requestAsr: () => deps.localAsr.ensureInstalled(),
    // Read the INFERENCE PLANE, not the ASR provider: any ready `hear`
    // provider counts, so the worker stays provider-agnostic. Plus the Silero
    // asset: the file route refuses to run without VAD (spec 2026-10-14), so
    // a broken install parks candidates here — before the fetch.
    hearReady: () =>
      deps.localAsr.vadAvailable() &&
      platform.inference
        .providers()
        .some((p) => p.supports.includes('hear') && p.status() === 'ready'),
    // The bundled file-path route — deliberately NOT on WorkerSession (spec §3).
    transcribeFile: (p, o) => deps.localAsr.transcribeFile(p, o),
  });
  platform.engine.attach(audioWorker);
  platform.lentWork.register(audioWorker, () => {
    const hear = platform.inference.fitness().find((f) => f.kind === 'hear');
    const ready =
      deps.localAsr.vadAvailable() &&
      hear !== undefined &&
      hear.local === 'ready';
    const now = ready ? ['hear'] : [];
    const can = hear && hear.local !== 'none' ? ['hear'] : [];
    // Only macOS decodes every format (transcode.ts); elsewhere wav and mp3.
    if (process.platform === 'darwin') {
      now.push('decode');
      can.push('decode');
    }
    return { ready, can, now };
  });
  registerRedrive(platform, audioWorker, [deps.localAsr]);

  return handle;
}

/** The deferred-work re-drive job shared by the bundled workers: gated on the
 *  processing window, also repairs missed vision work after the feed cursor,
 *  and triggers ONLY the installers passed for this worker — deferred OCR
 *  work must never download whisper, and deferred audio work must not keep
 *  Gemma installs warm (demand-only downloading, spec §5). The consumer is
 *  DERIVED from the worker (worker:<name>:v<version>) so a version bump can
 *  never desynchronise the gate from the engine's ledger. Exported for tests. */
const VISION_KINDS = ['see', 'read'] as const;

export function registerRedrive(
  platform: CorePlatform,
  worker: Worker,
  installers: Array<{ ensureInstalled(): void }>,
): void {
  platform.scheduler.register(
    `worker:${worker.name}`,
    worker.schedule as { every: string },
    async () => {
      // Audio runs its model here, never on a helper: the plain lane.
      const admitted =
        worker.name === 'vision'
          ? backgroundAdmits(platform, VISION_KINDS)
          : backgroundLaneOpen(platform);
      // Or a helper runs this worker's whole jobs while this device may not.
      if (!admitted && !platform.engine.lendsWork(worker)) return;
      const consumer = workerConsumerName(worker);
      // Existence probe, NOT a fetch: this gate used to pull every deferred
      // seq across the DB worker boundary — 2.1M rows in one structured-clone
      // reply — merely to ask whether the backlog was empty.
      const hasDeferred = await platform.store.ledgerHasDeferred(consumer);
      if (hasDeferred) {
        for (const i of installers) i.ensureInstalled(); // no-op if installed/downloading/opted-out
        await platform.engine.rerunDeferred(worker);
      }
      if (worker.name === 'vision')
        await platform.engine.rerunMissingVision(worker);
    },
  );
}
