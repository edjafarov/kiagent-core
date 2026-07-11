// Model catalog: descriptors, tiers and selectors. Curated catalog of GGUF
// models for the local-llm runtime, with pinned HuggingFace revisions and
// SHA-256 verification.

import path from 'node:path';
import type { Accel } from './backend';

export interface ModelFile {
  /** Local filename (also the name on HuggingFace). */
  name: string;
  /** Direct download URL (HF `resolve/<rev>/<name>`). */
  url: string;
  /** Expected SHA256 (HF LFS oid). The download fails closed on mismatch. */
  sha256: string;
  sizeBytes: number;
}

export interface ModelDescriptor {
  id: string;
  label: string;
  files: ModelFile[];
  /** The model's mmproj carries an audio encoder (verified via GGUF tensor
   *  inspection: `clip.has_audio_encoder` + a populated `a.blk.*` tower), so
   *  it can serve `hear` (ASR) requests. Absent/false → vision-only; the audio
   *  worker cleanly skips rather than deferring forever. The E-series (E4B/E2B)
   *  ship this encoder; the 12B mmproj declares the keys but not the full
   *  tower, so it is left audio-incapable until separately confirmed. */
  hasAudio?: boolean;
}

// Pinned to an immutable commit of unsloth/gemma-4-12b-it-GGUF (re-verify via
// the provenance note above before bumping REV).
const REPO = 'unsloth/gemma-4-12b-it-GGUF';
const REV = '3249fa54d5efa384afc552cc6700ad091efd5c39'; // verified head commit sha (2026-06-09)
const base = (name: string) =>
  `https://huggingface.co/${REPO}/resolve/${REV}/${name}`;

/**
 * The single curated default. A 12B-class Gemma vision model in GGUF at 4-bit,
 * from an ungated community mirror so download needs no HF token. Not
 * user-selectable in sub-project B.
 *
 * Provenance (verified against the live HuggingFace tree API on 2026-06-09):
 * - repo `unsloth/gemma-4-12b-it-GGUF`, gated=false
 * - pinned head commit sha: 3249fa54d5efa384afc552cc6700ad091efd5c39
 * - the sha256 values below are the HF LFS `oid` for each file.
 */
export const CURATED_MODEL: ModelDescriptor = {
  id: 'gemma-4-12b-it-Q4_K_M',
  label: 'Gemma 4 12B (4-bit)',
  files: [
    {
      name: 'gemma-4-12b-it-Q4_K_M.gguf',
      url: base('gemma-4-12b-it-Q4_K_M.gguf'),
      sha256:
        '43fec98c5102b1c446b4ddd0a9439f1db3a2e1f2e0b8cd143ce1ea619a9403d6',
      sizeBytes: 7121860000,
    },
    {
      name: 'mmproj-F16.gguf',
      url: base('mmproj-F16.gguf'),
      sha256:
        '91f086971e56d7a7d8d39e271873fccdb49541bd259d6e02c401a4f1cb7a219e',
      sizeBytes: 175115840,
    },
  ],
};

export function modelTotalBytes(m: ModelDescriptor): number {
  return m.files.reduce((n, f) => n + f.sizeBytes, 0);
}

// ── Hardware tiers (OCR-first design, 2026-06-10) ───────────────────────────
// Provenance verified against the live HuggingFace tree API on 2026-06-10:
// both repos gated=false; sha256 values are the HF LFS `oid` per file.

const E4B_REPO = 'unsloth/gemma-4-E4B-it-GGUF';
const E4B_REV = 'e1d90e5fb9f61d8dc71ef016580784a054e5c787';
const e4bUrl = (name: string) =>
  `https://huggingface.co/${E4B_REPO}/resolve/${E4B_REV}/${name}`;

export const E4B_MODEL: ModelDescriptor = {
  id: 'gemma-4-E4B-it-Q4_K_M',
  label: 'Gemma 4 E4B (4-bit)',
  hasAudio: true,
  files: [
    {
      name: 'gemma-4-E4B-it-Q4_K_M.gguf',
      url: e4bUrl('gemma-4-E4B-it-Q4_K_M.gguf'),
      sha256:
        '519b9793ed6ce0ff530f1b7c96e848e08e49e7af4d57bb97f76215963a54146d',
      sizeBytes: 4977169568,
    },
    {
      name: 'mmproj-F16.gguf',
      url: e4bUrl('mmproj-F16.gguf'),
      sha256:
        'ddf46c21d7078e95338cfc22306b19b276a29a5ad089023449dd54d4b6170a51',
      sizeBytes: 990372672,
    },
  ],
};

const E2B_REPO = 'unsloth/gemma-4-E2B-it-GGUF';
const E2B_REV = 'ecc8b33b2c50598815e4b0f7cea6088e3ae7adb8';
const e2bUrl = (name: string) =>
  `https://huggingface.co/${E2B_REPO}/resolve/${E2B_REV}/${name}`;

export const E2B_MODEL: ModelDescriptor = {
  id: 'gemma-4-E2B-it-Q4_K_M',
  label: 'Gemma 4 E2B (4-bit)',
  hasAudio: true,
  files: [
    {
      name: 'gemma-4-E2B-it-Q4_K_M.gguf',
      url: e2bUrl('gemma-4-E2B-it-Q4_K_M.gguf'),
      sha256:
        '9378bc471710229ef165709b62e34bfb62231420ddaf6d729e727305b5b8672d',
      sizeBytes: 3106736256,
    },
    {
      name: 'mmproj-F16.gguf',
      url: e2bUrl('mmproj-F16.gguf'),
      sha256:
        '140be8d7849741f88c50757d529b84373ee8e27052cc2236855b537f4a8215fa',
      sizeBytes: 985654080,
    },
  ],
};

// ── GLM-OCR descriptor ──────────────────────────────────────────────────────
// Pinned to an immutable commit of ggml-org/GLM-OCR-GGUF (Phase 0 decision,
// 2026-06-15). sha256 values are the HF LFS `oid` for each file.
// Sizes verified via the HuggingFace tree API on 2026-06-15.

const GLM_OCR_REPO = 'ggml-org/GLM-OCR-GGUF';
const GLM_OCR_REV = '65a42de1148dbed2297e922b5dbc7d9b70c36578'; // Phase 0 decision (2026-06-15)
const glmOcrUrl = (name: string) =>
  `https://huggingface.co/${GLM_OCR_REPO}/resolve/${GLM_OCR_REV}/${name}`;

/** GLM-OCR 0.9B — the cross-platform OCR engine, loaded on llama-server for the
 *  OCR pass on non-Mac hosts (the model-swap plan wires the load). Pinned from
 *  the Phase 0 feasibility decision. NOT a VLM tier — not added to CURATED_TIERS. */
export const GLM_OCR_MODEL: ModelDescriptor = {
  id: 'glm-ocr-Q8_0',
  label: 'GLM-OCR 0.9B',
  files: [
    {
      name: 'GLM-OCR-Q8_0.gguf',
      url: glmOcrUrl('GLM-OCR-Q8_0.gguf'),
      sha256:
        '45bc244a6446aff850521dc41f18bc8d7105ad5f0c2c8c28af04e7cc4f4d50b1',
      sizeBytes: 950433408,
    },
    {
      name: 'mmproj-GLM-OCR-Q8_0.gguf',
      url: glmOcrUrl('mmproj-GLM-OCR-Q8_0.gguf'),
      sha256:
        '9c4b58e33e316ed142eb5dcb41abec3844d3e6e5dc361ffb782c3fa9d175141f',
      sizeBytes: 484403648,
    },
  ],
};

export interface CuratedTier {
  /** Inclusive lower bound of TOTAL system RAM for this tier. */
  minRamBytes: number;
  model: ModelDescriptor;
}

/** Descending; first matching tier wins. Selection always lands on a real model. */
export const CURATED_TIERS: CuratedTier[] = [
  { minRamBytes: 48 * 1024 ** 3, model: CURATED_MODEL },
  { minRamBytes: 24 * 1024 ** 3, model: E4B_MODEL },
  { minRamBytes: 0, model: E2B_MODEL },
];

export interface ModelSelectInput {
  accel: Accel;
  capacityBytes: number;
}

/** CPU hosts force the smallest tier (a 12B is infeasible on CPU). Otherwise
 *  pick by capacity (VRAM for a discrete GPU, system RAM for Metal). */
export function selectCuratedModel(i: ModelSelectInput): ModelDescriptor {
  if (i.accel === 'cpu') return E2B_MODEL;
  const tier = CURATED_TIERS.find((t) => i.capacityBytes >= t.minRamBytes);
  return (tier ?? CURATED_TIERS[CURATED_TIERS.length - 1]).model;
}

/** Resolve a prefs modelOverride: 'auto'/unknown → null (caller falls back
 *  to selectCuratedModel), else the pinned descriptor. */
export function resolveModelOverride(
  override: string | undefined,
): ModelDescriptor | null {
  if (!override || override === 'auto') return null;
  return CURATED_TIERS.find((t) => t.model.id === override)?.model ?? null;
}

/** Compute the local directory for a model's cached files:
 *  <dataModelsDir>/<modelId>. */
export function modelDir(dataModelsDir: string, id: string): string {
  return path.join(dataModelsDir, id);
}
