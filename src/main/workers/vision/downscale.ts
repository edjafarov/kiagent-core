/**
 * Clamp an image to what the VLM can actually consume, BEFORE it is encoded
 * for the wire.
 *
 * Why this exists: `describeImage` (providers/local-llm/api.ts) turns the
 * bytes into a base64 string, then a `data:` URL, then a JSON body — three
 * full-size copies, each far past V8's ~256 KB large-object threshold, so none
 * of them is reclaimed by a scavenge. Measured on a real p99 photo from a user
 * corpus (5152x3864, 9.89 MB): 26.4 MB of heap churn per call, 13.2 MB held
 * for the lifetime of the request.
 *
 * The pixels being paid for are then thrown away. llama.cpp's mtmd picks a
 * fixed-size preprocessor for SigLIP-projector models (Gemma): a single resize
 * to image_size x image_size, 896 by default, for ANY input — and it does not
 * implement Gemma's pan-and-scan windowing, so there is no high-resolution
 * path that larger input could feed. Downscaling first is free of quality
 * loss above that edge because the server performs the identical resize.
 */

/** Longest edge the VLM can use. Above this, llama.cpp discards the detail. */
export const VLM_MAX_EDGE = 896;

/** Re-encode quality for the clamped image. */
export const VLM_JPEG_QUALITY = 82;

export interface DownscaleResult {
  bytes: Uint8Array;
  mime?: string;
}

/** Injected at the wiring layer so this module — and the vision worker —
 *  stay free of an `electron` import and remain jest-testable. */
export type ImageDownscaler = (
  bytes: Uint8Array,
  mime?: string,
) => Promise<DownscaleResult>;

/** Used wherever no resizer is wired (tests, non-Electron hosts). */
export const passthroughDownscaler: ImageDownscaler = async (bytes, mime) => ({
  bytes,
  mime,
});

/** The slice of Electron's `nativeImage` this needs. */
export interface NativeImageModule {
  createFromBuffer(buffer: Buffer): {
    isEmpty(): boolean;
    getSize(): { width: number; height: number };
    resize(opts: {
      width?: number;
      height?: number;
      quality?: 'good' | 'better' | 'best';
    }): {
      toJPEG(quality: number): Buffer;
      toPNG(): Buffer;
    };
  };
}

/**
 * `nativeImage` rather than sharp: sharp is a devDependency and absent from
 * `release/app`'s runtime dependencies, so using it would mean shipping a new
 * per-arch native module. nativeImage is already in the Electron we ship.
 *
 * PNG in, PNG out — a PNG source may carry an alpha channel that JPEG would
 * flatten to black, and rasterized PDF pages are line art, which PNG both
 * preserves exactly and compresses well. Everything else re-encodes to JPEG.
 *
 * Every failure path returns the ORIGINAL bytes: a clamp that cannot decode
 * the image must not also lose it. `isEmpty()` covers formats nativeImage
 * cannot read; the size check keeps already-small images off the re-encode
 * path entirely; and the final length check refuses a "clamp" that grew.
 */
export function makeNativeImageDownscaler(
  nativeImage: NativeImageModule,
  maxEdge: number = VLM_MAX_EDGE,
): ImageDownscaler {
  return async (bytes, mime) => {
    try {
      const img = nativeImage.createFromBuffer(Buffer.from(bytes));
      if (img.isEmpty()) return { bytes, mime };
      const { width, height } = img.getSize();
      if (width <= 0 || height <= 0) return { bytes, mime };
      if (Math.max(width, height) <= maxEdge) return { bytes, mime };

      // One edge only — nativeImage preserves the aspect ratio for the other.
      const resized = img.resize(
        width >= height
          ? { width: maxEdge, quality: 'good' }
          : { height: maxEdge, quality: 'good' },
      );
      const isPng = mime === 'image/png';
      const out = isPng ? resized.toPNG() : resized.toJPEG(VLM_JPEG_QUALITY);
      if (out.length === 0 || out.length >= bytes.length)
        return { bytes, mime };
      return {
        bytes: new Uint8Array(out),
        mime: isPng ? 'image/png' : 'image/jpeg',
      };
    } catch {
      return { bytes, mime };
    }
  };
}
