import {
  rasterizePdf,
  type RasterPage,
  type RasterResult,
} from '@main/core/converter/parsers';

export type { RasterPage, RasterResult };

/**
 * Structural subset of the apple-vision helper (Task 8,
 * src/main/providers/apple-vision/vision-helper.ts) — only what the picker
 * needs, so this module stays decoupled from the helper implementation.
 */
export interface VisionHelper {
  rasterizePdf(bytes: Uint8Array, pages: number[]): Promise<RasterResult>;
}

/** A helper ran past its deadline. Under background priority this is load,
 *  not a broken input: callers defer instead of burning retries. */
export class HelperTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HelperTimeoutError';
  }
}

/** Renders the requested 1-based pages (deduped, ascending); page numbers
 *  outside 1..pageCount are silently skipped. `maxEdge` (a VLM-only raster)
 *  renders straight at that longest edge; omitted = full-size 2× pages. */
export interface Rasterizer {
  pdfToPngs(
    bytes: Uint8Array,
    opts: { pages: number[]; maxEdge?: number; signal?: AbortSignal },
  ): Promise<RasterResult>;
}

export function wasmRasterizer(): Rasterizer {
  return {
    pdfToPngs: (bytes, { pages, maxEdge }) =>
      rasterizePdf(bytes, pages, maxEdge),
  };
}

export function pickRasterizer(
  helper: VisionHelper | null,
  platform = process.platform,
): Rasterizer {
  if (platform === 'darwin' && helper) {
    return {
      pdfToPngs: (bytes, { pages }) => helper.rasterizePdf(bytes, pages),
    };
  }
  return wasmRasterizer();
}
