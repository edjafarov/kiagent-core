import type { Handle, Worker } from '@shared/contracts';

import { backgroundLaneOpen } from '../core/boot';
import type { CorePlatform } from '../core/boot';
import { workerConsumerName } from '../core/engine/engine';
import type { VisionHelper } from '../providers/apple-vision/vision-helper';
import type { LocalAsrProvider } from '../providers/local-asr';
import type { LocalLlmProvider } from '../providers/local-llm/provider';
import { createAudioWorker } from './audio/audio-worker';
import { pickRasterizer } from './vision/rasterize';
import { createVisionWorker } from './vision/vision-worker';

export function attachBundledWorkers(
  platform: CorePlatform,
  deps: {
    visionHelper: VisionHelper | null;
    localLlm: LocalLlmProvider;
    localAsr: LocalAsrProvider;
  },
): Handle {
  const worker = createVisionWorker({
    rasterizer: pickRasterizer(deps.visionHelper),
    laneOpen: () => backgroundLaneOpen(platform),
  });
  const handle = platform.engine.attach(worker);
  // NOT boot.attachWorker: the re-drive job additionally (1) skips outside
  // the processing window and (2) triggers the model auto-install when
  // deferred vision work exists — the user-approved auto-download path.
  registerRedrive(platform, worker, [deps.localLlm]);

  // The audio transcription worker runs the SAME lifecycle over its own
  // consumer/cursor. Its handle is discarded like vision's — shutdown stops
  // every attached worker via engine.stopAll().
  const audioWorker = createAudioWorker({
    laneOpen: () => backgroundLaneOpen(platform),
  });
  platform.engine.attach(audioWorker);
  registerRedrive(platform, audioWorker, [deps.localAsr]);

  return handle;
}

/** The deferred-work re-drive job shared by the bundled workers: gated on the
 *  processing window, only runs when this worker actually has deferred work,
 *  and triggers ONLY the installers passed for this worker — deferred OCR
 *  work must never download whisper, and deferred audio work must not keep
 *  Gemma installs warm (demand-only downloading, spec §5). The consumer is
 *  DERIVED from the worker (worker:<name>:v<version>) so a version bump can
 *  never desynchronise the gate from the engine's ledger. Exported for tests. */
export function registerRedrive(
  platform: CorePlatform,
  worker: Worker,
  installers: Array<{ ensureInstalled(): void }>,
): void {
  platform.scheduler.register(
    `worker:${worker.name}`,
    worker.schedule as { every: string },
    async () => {
      if (!backgroundLaneOpen(platform)) return;
      const consumer = workerConsumerName(worker);
      if ((await platform.store.ledgerDeferred(consumer)).length === 0) return;
      for (const i of installers) i.ensureInstalled(); // no-op if installed/downloading/opted-out
      await platform.engine.rerunDeferred(worker);
    },
  );
}
