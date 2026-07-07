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

describe('rasterizer', () => {
  describe('wasmRasterizer', () => {
    it('respects maxPages limit', async () => {
      const rasterizer = wasmRasterizer();
      const pngs = await rasterizer.pdfToPngs(new Uint8Array([0, 1, 2]), 2);
      expect(pngs).toHaveLength(2);
    });

    it('converts BGRA to RGBA', async () => {
      const rasterizer = wasmRasterizer();
      const pngs = await rasterizer.pdfToPngs(new Uint8Array([0, 1, 2]), 1);
      expect(pngs).toHaveLength(1);

      // Decode the PNG: BGRA [1, 2, 3, 4] must come back as RGBA [3, 2, 1, 4].
      const png = PNG.sync.read(Buffer.from(pngs[0]));
      expect([...png.data]).toEqual([3, 2, 1, 4]);
    });
  });

  describe('pickRasterizer', () => {
    it('delegates to helper.rasterizePdf on darwin with helper', async () => {
      const helperPages = [new Uint8Array([1])];
      const helper: VisionHelper = {
        rasterizePdf: jest.fn(async () => helperPages),
      };

      const rasterizer = pickRasterizer(helper, 'darwin');
      const pngs = await rasterizer.pdfToPngs(new Uint8Array([0, 1, 2]), 1);

      expect(pngs).toBe(helperPages);
      expect(helper.rasterizePdf).toHaveBeenCalledWith(
        new Uint8Array([0, 1, 2]),
        1,
      );
    });

    it('returns wasm rasterizer on darwin without helper', async () => {
      const rasterizer = pickRasterizer(null, 'darwin');
      const pngs = await rasterizer.pdfToPngs(new Uint8Array([0, 1, 2]), 1);
      expect(pngs).toHaveLength(1);
    });

    it('returns wasm rasterizer on non-darwin platform', async () => {
      const helper: VisionHelper = {
        rasterizePdf: jest.fn(async () => [new Uint8Array([1])]),
      };

      const rasterizer = pickRasterizer(helper, 'linux');
      const pngs = await rasterizer.pdfToPngs(new Uint8Array([0, 1, 2]), 1);
      expect(pngs).toHaveLength(1);
      expect(helper.rasterizePdf).not.toHaveBeenCalled();
    });
  });
});
