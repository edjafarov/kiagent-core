// ASR model catalog: whisper.cpp GGML models, tiered on whisper's OWN
// accelerator (darwin Metal vs CPU everywhere else — the vendored non-darwin
// binaries are CPU-only, so a Vulkan-capable llama backend is irrelevant
// here). Pinned HF revision + sha256, same conventions as local-llm/models.
import type { ModelDescriptor } from '../local-llm/models';

export type AsrAccel = 'metal' | 'cpu';

export function asrAccel(
  platform: NodeJS.Platform = process.platform,
): AsrAccel {
  return platform === 'darwin' ? 'metal' : 'cpu';
}

// Pinned to an immutable commit of ggerganov/whisper.cpp (model repo,
// ungated). sha256 = the HF LFS oid per file (verified 2026-08-12).
const REPO = 'ggerganov/whisper.cpp';
const REV = '5359861c739e955e79d9a303bcbc70fb988958b1';
const url = (name: string) =>
  `https://huggingface.co/${REPO}/resolve/${REV}/${name}`;

export const WHISPER_LARGE_V3_TURBO_Q5_0: ModelDescriptor = {
  id: 'whisper-large-v3-turbo-q5_0',
  label: 'Whisper large-v3-turbo (5-bit)',
  files: [
    {
      name: 'ggml-large-v3-turbo-q5_0.bin',
      url: url('ggml-large-v3-turbo-q5_0.bin'),
      sha256:
        '394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2',
      sizeBytes: 574041195,
    },
  ],
};

export const WHISPER_SMALL_Q5_1: ModelDescriptor = {
  id: 'whisper-small-q5_1',
  label: 'Whisper small (5-bit)',
  files: [
    {
      name: 'ggml-small-q5_1.bin',
      url: url('ggml-small-q5_1.bin'),
      sha256:
        'ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb',
      sizeBytes: 190085487,
    },
  ],
};

export const WHISPER_BASE_Q5_1: ModelDescriptor = {
  id: 'whisper-base-q5_1',
  label: 'Whisper base (5-bit)',
  files: [
    {
      name: 'ggml-base-q5_1.bin',
      url: url('ggml-base-q5_1.bin'),
      sha256:
        '422f1ae452ade6f30a004d7e5c6a43195e4433bc370bf23fac9cc591f01a8898',
      sizeBytes: 59707625,
    },
  ],
};

export interface AsrTier {
  /** Tier requires this accel; null = any. */
  accel: AsrAccel | null;
  /** Inclusive lower bound of TOTAL system RAM. */
  minRamBytes: number;
  model: ModelDescriptor;
}

/** First match wins, mirroring CURATED_TIERS. The floor is `small`, not
 *  `base`, on purpose: base degrades sharply on non-English speech and this
 *  corpus is German/Ukrainian/English (spec §4). large-v3-turbo is
 *  metal-gated — on CPU it is painfully slow regardless of RAM. */
export const ASR_TIERS: AsrTier[] = [
  {
    accel: 'metal',
    minRamBytes: 16 * 1024 ** 3,
    model: WHISPER_LARGE_V3_TURBO_Q5_0,
  },
  { accel: null, minRamBytes: 8 * 1024 ** 3, model: WHISPER_SMALL_Q5_1 },
  { accel: null, minRamBytes: 0, model: WHISPER_BASE_Q5_1 },
];

export function selectAsrModel(i: {
  accel: AsrAccel;
  totalMemBytes: number;
}): ModelDescriptor {
  const tier = ASR_TIERS.find(
    (t) =>
      (t.accel === null || t.accel === i.accel) &&
      i.totalMemBytes >= t.minRamBytes,
  );
  return (tier ?? ASR_TIERS[ASR_TIERS.length - 1]).model;
}

/** Resolve a model id against the ASR catalog ONLY — a Gemma id returns null,
 *  which is one half of the models-dir namespacing (spec §2): local-asr can
 *  never mistake a Gemma install for a whisper model. (The other half is
 *  local-llm's resolveModelOverride returning null for whisper ids — its
 *  catalog never contains them.) */
export function resolveAsrModel(id: string): ModelDescriptor | null {
  return ASR_TIERS.find((t) => t.model.id === id)?.model ?? null;
}
