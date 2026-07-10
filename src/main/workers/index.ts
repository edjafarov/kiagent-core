import type { Handle, Worker } from '@shared/contracts';

import { backgroundLaneOpen } from '../core/boot';
import type { CorePlatform } from '../core/boot';
import type { VisionHelper } from '../providers/apple-vision/vision-helper';
import type { LocalLlmProvider } from '../providers/local-llm/provider';
import { createAudioWorker } from './audio/audio-worker';
import { pickRasterizer } from './vision/rasterize';
import { createVisionWorker } from './vision/vision-worker';

export const VISION_CONSUMER = 'worker:vision:v1';
export const AUDIO_CONSUMER = 'worker:audio:v1';

export function attachBundledWorkers(
  platform: CorePlatform,
  deps: { visionHelper: VisionHelper | null; localLlm: LocalLlmProvider },
): Handle {
  const worker = createVisionWorker({
    rasterizer: pickRasterizer(deps.visionHelper),
    laneOpen: () => backgroundLaneOpen(platform),
  });
  const handle = platform.engine.attach(worker);
  // NOT boot.attachWorker: the re-drive job additionally (1) skips outside
  // the processing window and (2) triggers the model auto-install when
  // deferred vision work exists — the user-approved auto-download path.
  registerRedrive(platform, worker, VISION_CONSUMER, deps.localLlm);

  // The audio transcription worker runs the SAME lifecycle over its own
  // consumer/cursor, reusing the already-loaded llama-server (the E-series
  // mmproj is a unified vision+audio projector). Its handle is discarded like
  // vision's — shutdown stops every attached worker via engine.stopAll().
  const audioWorker = createAudioWorker({
    laneOpen: () => backgroundLaneOpen(platform),
  });
  platform.engine.attach(audioWorker);
  registerRedrive(platform, audioWorker, AUDIO_CONSUMER, deps.localLlm);

  return handle;
}

/** The deferred-work re-drive job shared by the bundled workers: gated on the
 *  processing window, only runs when this worker actually has deferred work,
 *  and triggers the user-approved model auto-install when it does. */
function registerRedrive(
  platform: CorePlatform,
  worker: Worker,
  consumer: string,
  localLlm: LocalLlmProvider,
): void {
  platform.scheduler.register(
    `worker:${worker.name}`,
    worker.schedule as { every: string },
    async () => {
      if (!backgroundLaneOpen(platform)) return;
      if ((await platform.store.ledgerDeferred(consumer)).length === 0) return;
      localLlm.ensureInstalled(); // no-op if installed/downloading/opted-out
      await platform.engine.rerunDeferred(worker);
    },
  );
}
