import type { Handle } from '@shared/contracts';

import { backgroundLaneOpen } from '../core/boot';
import type { CorePlatform } from '../core/boot';
import type { VisionHelper } from '../providers/apple-vision/vision-helper';
import type { LocalLlmProvider } from '../providers/local-llm/provider';
import { pickRasterizer } from './vision/rasterize';
import { createVisionWorker } from './vision/vision-worker';

export const VISION_CONSUMER = 'worker:vision:v1';

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
  platform.scheduler.register(
    `worker:${worker.name}`,
    worker.schedule as { every: string },
    async () => {
      if (!backgroundLaneOpen(platform)) return;
      if ((await platform.store.ledgerDeferred(VISION_CONSUMER)).length === 0)
        return;
      deps.localLlm.ensureInstalled(); // no-op if installed/downloading/opted-out
      await platform.engine.rerunDeferred(worker);
    },
  );
  return handle;
}
