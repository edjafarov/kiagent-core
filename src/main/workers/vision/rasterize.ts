import { PNG } from 'pngjs';

/**
 * Structural subset of the apple-vision helper (Task 8,
 * src/main/providers/apple-vision/vision-helper.ts) — only what the picker
 * needs, so this module stays decoupled from the helper implementation.
 */
export interface VisionHelper {
  rasterizePdf(bytes: Uint8Array, maxPages: number): Promise<Uint8Array[]>;
}

export interface Rasterizer {
  pdfToPngs(bytes: Uint8Array, maxPages: number): Promise<Uint8Array[]>;
}

const DEFAULT_SCALE = 2;

/**
 * pdfium renders in BGRA; pngjs expects RGBA — swap B and R in-place.
 */
function bgraToRgba(data: Uint8Array): Buffer {
  const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  for (let i = 0; i < buf.length; i += 4) {
    const b = buf[i];
    buf[i] = buf[i + 2]; // R ← B
    buf[i + 2] = b; // B ← R
  }
  return buf;
}

function encodePng(data: Uint8Array, width: number, height: number): Buffer {
  const png = new PNG({ width, height });
  png.data = bgraToRgba(data);
  return PNG.sync.write(png);
}

export function wasmRasterizer(): Rasterizer {
  return {
    async pdfToPngs(
      bytes: Uint8Array,
      maxPages: number,
    ): Promise<Uint8Array[]> {
      // @hyzyla/pdfium is ESM-only; this module compiles to CommonJS, so it must
      // be pulled in via dynamic import rather than a static (require-producing) one.
      const { PDFiumLibrary } = await import('@hyzyla/pdfium');
      const library = await PDFiumLibrary.init();
      try {
        const doc = await library.loadDocument(bytes);
        try {
          const pageCount = doc.getPageCount();
          const limit = Math.min(maxPages, pageCount);
          const pngs: Uint8Array[] = [];

          for (let i = 0; i < limit; i++) {
            const page = doc.getPage(i);
            const img = await page.render({
              scale: DEFAULT_SCALE,
              render: 'bitmap',
            });
            const buf = encodePng(img.data, img.width, img.height);
            pngs.push(new Uint8Array(buf));
          }

          return pngs;
        } finally {
          doc.destroy();
        }
      } finally {
        library.destroy();
      }
    },
  };
}

export function pickRasterizer(
  helper: VisionHelper | null,
  platform = process.platform,
): Rasterizer {
  if (platform === 'darwin' && helper) {
    return {
      pdfToPngs: (bytes, maxPages) => helper.rasterizePdf(bytes, maxPages),
    };
  }
  return wasmRasterizer();
}
