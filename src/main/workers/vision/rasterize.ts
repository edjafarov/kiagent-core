import { PNG } from 'pngjs';

/**
 * Structural subset of the apple-vision helper (Task 8,
 * src/main/providers/apple-vision/vision-helper.ts) — only what the picker
 * needs, so this module stays decoupled from the helper implementation.
 */
export interface VisionHelper {
  rasterizePdf(bytes: Uint8Array, pages: number[]): Promise<RasterResult>;
}

/** One rendered page; `page` is 1-based. */
export interface RasterPage {
  page: number;
  png: Uint8Array;
}

export interface RasterResult {
  pageCount: number;
  pages: RasterPage[];
}

/** Renders the requested 1-based pages (deduped, ascending); page numbers
 *  outside 1..pageCount are silently skipped. */
export interface Rasterizer {
  pdfToPngs(
    bytes: Uint8Array,
    opts: { pages: number[] },
  ): Promise<RasterResult>;
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
    async pdfToPngs(bytes, { pages }) {
      // @hyzyla/pdfium is ESM-only; this module compiles to CommonJS, so it must
      // be pulled in via dynamic import rather than a static (require-producing) one.
      const { PDFiumLibrary } = await import('@hyzyla/pdfium');
      const library = await PDFiumLibrary.init();
      try {
        const doc = await library.loadDocument(bytes);
        try {
          const pageCount = doc.getPageCount();
          const wanted = [...new Set(pages)]
            .filter((n) => n >= 1 && n <= pageCount)
            .sort((a, b) => a - b);
          const out: RasterPage[] = [];

          for (const n of wanted) {
            const page = doc.getPage(n - 1);
            const img = await page.render({
              scale: DEFAULT_SCALE,
              render: 'bitmap',
            });
            const buf = encodePng(img.data, img.width, img.height);
            out.push({ page: n, png: new Uint8Array(buf) });
          }

          return { pageCount, pages: out };
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
      pdfToPngs: (bytes, { pages }) => helper.rasterizePdf(bytes, pages),
    };
  }
  return wasmRasterizer();
}
