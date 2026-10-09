import type { Converter } from '@main/core/converter/converter';
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

/** macOS with the native helper: the helper (unchanged). Everywhere else:
 *  the kia-converter child when one is given (#136-C), so the pdfium render,
 *  BGRA swap and PNG encode run off main; the in-process WASM path only for
 *  tests and hosts that pass none. */
export function pickRasterizer(
  helper: VisionHelper | null,
  // Positional for the existing (helper, platform) call sites and tests.
  // eslint-disable-next-line default-param-last
  platform = process.platform,
  converter?: Pick<Converter, 'rasterizePdf'>,
): Rasterizer {
  if (platform === 'darwin' && helper) {
    return {
      pdfToPngs: (bytes, { pages }) => helper.rasterizePdf(bytes, pages),
    };
  }
  if (converter)
    return {
      pdfToPngs: (bytes, { pages, maxEdge, signal }) =>
        converter.rasterizePdf(bytes, pages, { maxEdge, signal }),
    };
  return wasmRasterizer();
}
