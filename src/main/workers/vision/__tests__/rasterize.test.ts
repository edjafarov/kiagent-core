/** @jest-environment node */
import { PNG } from 'pngjs';
import {
  pickRasterizer,
  wasmRasterizer,
  type VisionHelper,
} from '../rasterize';

jest.mock('@hyzyla/pdfium', () => ({
  PDFiumLibrary: {
    init: jest.fn(async () => ({
      loadDocument: jest.fn(async () => ({
        getPageCount: jest.fn(() => 3),
        getPage: jest.fn(() => ({
          // 1×1 page in BGRA — the port must swap to RGBA before encoding.
          render: jest.fn(async () => ({
            data: new Uint8Array([1, 2, 3, 4]),
            width: 1,
            height: 1,
          })),
        })),
        destroy: jest.fn(),
      })),
      destroy: jest.fn(),
    })),
  },
}));

const PNG_MAGIC = new Uint8Array([0x50, 0x4e, 0x47]);

describe('rasterizer', () => {
  describe('wasmRasterizer', () => {
    it('renders only the requested pages and reports pageCount', async () => {
      const r = await wasmRasterizer().pdfToPngs(new Uint8Array([0, 1, 2]), {
        pages: [3, 1, 9, 1],
      });
      expect(r.pageCount).toBe(3);
      expect(r.pages.map((p) => p.page)).toEqual([1, 3]); // sorted, deduped, 9 skipped
      for (const p of r.pages) expect(p.png.subarray(1, 4)).toEqual(PNG_MAGIC);
    });

    it('converts BGRA to RGBA', async () => {
      const r = await wasmRasterizer().pdfToPngs(new Uint8Array([0, 1, 2]), {
        pages: [1],
      });
      expect(r.pages).toHaveLength(1);

      // Decode the PNG: BGRA [1, 2, 3, 4] must come back as RGBA [3, 2, 1, 4].
      const png = PNG.sync.read(Buffer.from(r.pages[0].png));
      expect([...png.data]).toEqual([3, 2, 1, 4]);
    });
  });

  describe('pickRasterizer', () => {
    it('off darwin, a converter rasterises (with maxEdge and signal)', async () => {
      const result = { pageCount: 1, pages: [] };
      const converter = { rasterizePdf: jest.fn(async () => result) };
      const { signal } = new AbortController();
      const r = await pickRasterizer(null, 'win32', converter).pdfToPngs(
        new Uint8Array([1]),
        {
          pages: [1],
          maxEdge: 896,
          signal,
        },
      );
      expect(r).toBe(result);
      expect(converter.rasterizePdf).toHaveBeenCalledWith(
        new Uint8Array([1]),
        [1],
        { maxEdge: 896, signal },
      );
    });
    it('darwin with the native helper ignores the converter', async () => {
      const helper: VisionHelper = {
        rasterizePdf: jest.fn(async () => ({ pageCount: 1, pages: [] })),
      };
      const converter = { rasterizePdf: jest.fn() };
      await pickRasterizer(helper, 'darwin', converter).pdfToPngs(
        new Uint8Array([1]),
        { pages: [1] },
      );
      expect(converter.rasterizePdf).not.toHaveBeenCalled();
    });
    it('delegates to helper.rasterizePdf on darwin with helper', async () => {
      const helperResult = {
        pageCount: 5,
        pages: [{ page: 2, png: new Uint8Array([1]) }],
      };
      const helper: VisionHelper = {
        rasterizePdf: jest.fn(async () => helperResult),
      };

      const rasterizer = pickRasterizer(helper, 'darwin');
      const r = await rasterizer.pdfToPngs(new Uint8Array([0, 1, 2]), {
        pages: [2],
      });

      expect(r).toBe(helperResult);
      expect(helper.rasterizePdf).toHaveBeenCalledWith(
        new Uint8Array([0, 1, 2]),
        [2],
      );
    });

    it('returns wasm rasterizer on darwin without helper', async () => {
      const r = await pickRasterizer(null, 'darwin').pdfToPngs(
        new Uint8Array([0, 1, 2]),
        { pages: [1] },
      );
      expect(r.pages).toHaveLength(1);
    });

    it('returns wasm rasterizer on non-darwin platform', async () => {
      const helper: VisionHelper = {
        rasterizePdf: jest.fn(async () => ({ pageCount: 1, pages: [] })),
      };

      const r = await pickRasterizer(helper, 'linux').pdfToPngs(
        new Uint8Array([0, 1, 2]),
        { pages: [1] },
      );
      expect(r.pages).toHaveLength(1);
      expect(helper.rasterizePdf).not.toHaveBeenCalled();
    });
  });
});
