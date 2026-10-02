/** @jest-environment node */
import type { Change, Document, WorkerSession } from '@shared/contracts';
import { LaneClosedError, NoProviderError } from '@main/core/inference';
import { MAX_LOCAL_BINARY_BYTES } from '@shared/file-indexability';
import {
  multiPagePdf,
  PROSE_LINES,
  shifted,
} from '@main/core/engine/__tests__/pdf-fixture';
import type { Rasterizer } from '../rasterize';

import { MAX_PDF_BYTES } from '../classify';
import { createVisionWorker } from '../vision-worker';

/** Rasterizer result for pages 1..n holding the given PNGs. */
const raster = (...pngs: Uint8Array[]) => ({
  pageCount: pngs.length,
  pages: pngs.map((png, i) => ({ page: i + 1, png })),
});

const baseDoc = {
  id: 'd',
  accountId: 'a',
  externalId: 'x',
  type: 'attachment',
  title: 'scan.pdf',
  markdown: null,
  metadata: {
    mime: 'application/pdf',
    sizeBytes: 50_000,
    conversion: { status: 'text-poor' },
  },
  createdAt: null,
  parentId: null,
  contentHash: 'h',
  seq: 1,
  ingestSeq: 1,
  archivedAt: null,
  languages: [],
  ingestedAt: '2026-01-01',
  updatedAt: '2026-01-01',
  scopeRootId: null,
} as Document;

function fakeSession(
  over: Partial<WorkerSession> = {},
): WorkerSession & { enriched: any[] } {
  const enriched: any[] = [];
  const s: WorkerSession & { enriched: any[] } = {
    enriched,
    signal: new AbortController().signal,
    inference: async () => 'x',
    see: async () => 'a description of the page',
    // Delegates to `see` at call time, so a test's `see` override or spy
    // is what pass 2 sees; `seeMeta` names who answered.
    seeWithMeta: async (image, prompt, opts) => ({
      text: await s.see(image, prompt, opts),
      ...seeMeta,
    }),
    read: async () => 'plenty of ocr text '.repeat(20), // > 200 chars
    hear: async () => 'a transcript',
    fetchBytes: async () => new Uint8Array(100_000),
    bump: async () => 1,
    mayBecomeReady: () => false,
    emit: () => {},
    enrich: (e) => enriched.push(e),
    log: () => {},
    ...over,
  };
  return s;
}
let seeMeta = { providerId: 'local', modelId: 'vlm' };
beforeEach(() => {
  seeMeta = { providerId: 'local', modelId: 'vlm' };
});

const change = (doc: Partial<Document>) =>
  ({ seq: 1, kind: 'document', document: { ...baseDoc, ...doc } }) as Change;

it('OCR-sufficient PDF → done, enrich with per-page OCR, no `see` call', async () => {
  const session = fakeSession();
  const see = jest.spyOn(session, 'see');
  const rasterizer: Rasterizer = {
    pdfToPngs: jest.fn(async () =>
      raster(new Uint8Array([1]), new Uint8Array([2])),
    ),
  };

  const worker = createVisionWorker({
    rasterizer,
    laneOpen: () => true,
  });

  const result = await worker.work(change({}), session);

  expect(result).toBe('done');
  expect(session.enriched).toHaveLength(1);
  expect(session.enriched[0].markdown).toContain('--- page 1 ---');
  expect(session.enriched[0].markdown).toContain('plenty of ocr text');
  expect(session.enriched[0].metadata?.extraction?.engine).toBe('local-ocr');
  expect(see).not.toHaveBeenCalled();
});

it('Thin OCR + see available → done with descriptions', async () => {
  const session = fakeSession({ read: async () => 'thin' });
  const rasterizer: Rasterizer = {
    pdfToPngs: jest.fn(async () => raster(new Uint8Array([1]))),
  };

  const worker = createVisionWorker({
    rasterizer,
    laneOpen: () => true,
  });

  const result = await worker.work(change({}), session);

  expect(result).toBe('done');
  expect(session.enriched).toHaveLength(1);
  expect(session.enriched[0].markdown).toContain('**Description:**');
  expect(session.enriched[0].metadata?.extraction?.engine).toBe(
    'local-ocr+vlm',
  );
});

it('Thin OCR + see throws (no provider) → defer', async () => {
  const session = fakeSession({
    read: async () => 'thin',
    see: async () => {
      throw new Error('no inference provider');
    },
  });
  const rasterizer: Rasterizer = {
    pdfToPngs: jest.fn(async () => raster(new Uint8Array([1]))),
  };

  const worker = createVisionWorker({
    rasterizer,
    laneOpen: () => true,
  });

  const result = await worker.work(change({}), session);

  expect(result).toBe('defer');
  expect(session.enriched).toHaveLength(0);
});

it('read throws NoProviderError (no OCR provider, e.g. non-mac) → straight to see', async () => {
  const session = fakeSession({
    read: async () => {
      throw new NoProviderError('read');
    },
  });
  const rasterizer: Rasterizer = {
    pdfToPngs: jest.fn(async () => raster(new Uint8Array([1]))),
  };

  const worker = createVisionWorker({
    rasterizer,
    laneOpen: () => true,
  });

  const result = await worker.work(change({}), session);

  expect(result).toBe('done');
  expect(session.enriched).toHaveLength(1);
  expect(session.enriched[0].markdown).toContain('**Description:**');
  expect(session.enriched[0].markdown).not.toContain('**Text content (OCR):**');
});

// Finding 3: a crashed OCR helper is transient, not "no provider". It must
// DEFER (so the re-drive recovers the doc) rather than silently degrade to
// pass 2 — which, before the fix, left a doc permanently OCR-less.
it('read throws a generic error (helper crash) → defer, no enrich', async () => {
  const see = jest.fn(async () => 'a description of the page');
  const session = fakeSession({
    read: async () => {
      throw new Error('helper segfault');
    },
    see,
  });
  const rasterizer: Rasterizer = {
    pdfToPngs: jest.fn(async () => raster(new Uint8Array([1]))),
  };

  const worker = createVisionWorker({
    rasterizer,
    laneOpen: () => true,
  });

  const result = await worker.work(change({}), session);

  expect(result).toBe('defer');
  expect(session.enriched).toHaveLength(0);
  expect(see).not.toHaveBeenCalled(); // did NOT fall through to pass 2
});

// Finding 5b: a text-poor image in a format the VLM can't decode
// (HEIC/WebP/TIFF) must NOT defer to pass 2 forever — it completes with the
// OCR-only result instead. apple-vision OCR still ran in pass 1.
it('text-poor HEIC → done with OCR-only enrich, never calls see', async () => {
  const see = jest.fn(async () => 'should not run');
  const session = fakeSession({ read: async () => 'thin', see });
  const rasterizer: Rasterizer = { pdfToPngs: jest.fn() };

  const worker = createVisionWorker({
    rasterizer,
    laneOpen: () => true,
  });

  const result = await worker.work(
    change({
      title: 'photo.heic',
      metadata: { mime: 'image/heic', sizeBytes: 50_000 },
      type: 'file',
    }),
    session,
  );

  expect(result).toBe('done');
  expect(see).not.toHaveBeenCalled();
  expect(session.enriched).toHaveLength(1);
  expect(session.enriched[0].metadata?.extraction?.engine).toBe('local-ocr');
  expect(session.enriched[0].markdown).toContain('thin');
});

it('Lane closed → defer immediately', async () => {
  const session = fakeSession();
  const fetchBytes = jest.spyOn(session, 'fetchBytes');
  const rasterizer: Rasterizer = {
    pdfToPngs: jest.fn(),
  };

  const worker = createVisionWorker({
    rasterizer,
    laneOpen: () => false,
  });

  const result = await worker.work(change({}), session);

  expect(result).toBe('defer');
  expect(fetchBytes).not.toHaveBeenCalled();
});

it('fetchBytes null → skip', async () => {
  const session = fakeSession({ fetchBytes: async () => null });
  const rasterizer: Rasterizer = {
    pdfToPngs: jest.fn(),
  };

  const worker = createVisionWorker({
    rasterizer,
    laneOpen: () => true,
  });

  const result = await worker.work(change({}), session);

  expect(result).toBe('skip');
});

it('oversized PDF → skip', async () => {
  const session = fakeSession({
    fetchBytes: async () => new Uint8Array(MAX_PDF_BYTES + 1),
  });
  const rasterizer: Rasterizer = {
    pdfToPngs: jest.fn(),
  };

  const worker = createVisionWorker({
    rasterizer,
    laneOpen: () => true,
  });

  const result = await worker.work(change({}), session);

  expect(result).toBe('skip');
});

it('Image doc: rasterizer NOT called, single page', async () => {
  const session = fakeSession();
  const rasterizer: Rasterizer = {
    pdfToPngs: jest.fn(),
  };

  const worker = createVisionWorker({
    rasterizer,
    laneOpen: () => true,
  });

  const result = await worker.work(
    change({
      title: 'photo.png',
      metadata: { mime: 'image/png', sizeBytes: 50_000 },
      type: 'file',
    }),
    session,
  );

  expect(result).toBe('done');
  expect(rasterizer.pdfToPngs).not.toHaveBeenCalled();
  expect(session.enriched).toHaveLength(1);
});

it('matches(): candidate document change → true', () => {
  const worker = createVisionWorker({
    rasterizer: { pdfToPngs: jest.fn() },
    laneOpen: () => true,
  });

  const c = change({});
  expect(worker.matches(c)).toBe(true);
});

it('matches(): account change → false', () => {
  const worker = createVisionWorker({
    rasterizer: { pdfToPngs: jest.fn() },
    laneOpen: () => true,
  });

  const c = { seq: 1, kind: 'account', account: {} } as any;
  expect(worker.matches(c)).toBe(false);
});

it('worker has correct metadata', () => {
  const worker = createVisionWorker({
    rasterizer: { pdfToPngs: jest.fn() },
    laneOpen: () => true,
  });

  expect(worker.name).toBe('vision');
  expect(worker.version).toBe(1);
  expect(worker.schedule).toEqual({ every: '30m' });
});

it('downscales for `see` but hands `read` the FULL-SIZE page', async () => {
  // OCR accuracy scales with resolution and the helper takes a temp-file
  // path (no JS heap cost); the VLM is the one that base64-encodes the bytes
  // into three full-size heap strings AND discards the extra pixels. So the
  // clamp must land on pass 2 only.
  const full = new Uint8Array(9_000_000);
  const shrunk = new Uint8Array(190_000);
  const session = fakeSession({
    fetchBytes: async () => full,
    read: async () => 'too short', // < OCR_SUFFICIENT_CHARS → falls to pass 2
  });
  const see = jest.spyOn(session, 'see');
  const read = jest.spyOn(session, 'read');

  const worker = createVisionWorker({
    rasterizer: { pdfToPngs: jest.fn() },
    laneOpen: () => true,
    downscale: async () => ({ bytes: shrunk, mime: 'image/jpeg' }),
  });

  const result = await worker.work(
    change({ metadata: { mime: 'image/jpeg', filename: 'photo.jpg' } }),
    session,
  );

  expect(result).toBe('done');
  expect(read).toHaveBeenCalledWith(full, { mime: 'image/jpeg' });
  expect(see).toHaveBeenCalledWith(shrunk, expect.any(String), {
    mime: 'image/jpeg',
    task: 'vision.describe',
  });
});

it('with no downscaler wired, `see` gets the original bytes (identity fallback)', async () => {
  const full = new Uint8Array(9_000_000);
  const session = fakeSession({
    fetchBytes: async () => full,
    read: async () => 'too short',
  });
  const see = jest.spyOn(session, 'see');

  const worker = createVisionWorker({
    rasterizer: { pdfToPngs: jest.fn() },
    laneOpen: () => true,
  });

  await worker.work(
    change({ metadata: { mime: 'image/jpeg', filename: 'photo.jpg' } }),
    session,
  );

  expect(see).toHaveBeenCalledWith(full, expect.any(String), {
    mime: 'image/jpeg',
    task: 'vision.describe',
  });
});

it("pass 2 passes the task 'vision.describe'", async () => {
  const opts: unknown[] = [];
  const session = fakeSession({
    read: async () => 'thin',
    seeWithMeta: async (_b, _p, o) => {
      opts.push(o);
      return { text: 'd', providerId: 'local', modelId: 'vlm' };
    },
  });
  const worker = createVisionWorker({
    rasterizer: { pdfToPngs: jest.fn(async () => raster(new Uint8Array([1]))) },
    laneOpen: () => true,
  });
  await expect(worker.work(change({}), session)).resolves.toBe('done');
  expect(opts[0]).toMatchObject({ task: 'vision.describe' });
});

it('mixed providers across pages aggregate into extraction.providers', async () => {
  let n = 0;
  const session = fakeSession({
    read: async () => 'thin',
    seeWithMeta: async () => {
      n += 1;
      return n <= 3
        ? { text: `r${n}`, providerId: 'r', modelId: 'm1' }
        : { text: `l${n}`, providerId: 'local', modelId: 'm2' };
    },
  });
  const worker = createVisionWorker({
    rasterizer: {
      pdfToPngs: jest.fn(async () =>
        raster(...Array.from({ length: 5 }, (_, i) => new Uint8Array([i]))),
      ),
    },
    laneOpen: () => true,
  });
  await expect(worker.work(change({}), session)).resolves.toBe('done');
  const { extraction } = session.enriched[0].metadata;
  expect(extraction.engine).toBe('local-ocr+vlm');
  expect(extraction.providers).toEqual([
    { providerId: 'r', modelId: 'm1', pages: 3 },
    { providerId: 'local', modelId: 'm2', pages: 2 },
  ]);
});

describe('windowed OCR', () => {
  function pagedRasterizer(pageCount: number) {
    const calls: number[][] = [];
    const r: Rasterizer = {
      pdfToPngs: jest.fn(async (_b, { pages }) => {
        calls.push(pages);
        return {
          pageCount,
          pages: pages
            .filter((n) => n <= pageCount)
            .map((n) => ({ page: n, png: new Uint8Array([n]) })),
        };
      }),
    };
    return { r, calls };
  }
  const ocrByPage = async (img: Uint8Array) => `page text ${img[0]} `.repeat(5);
  const withProgress = (ocrProgress: unknown) =>
    change({ metadata: { ...baseDoc.metadata, ocrProgress } });

  it('OCRs the first 10 pages, records progress, re-renders markdown, returns done', async () => {
    const { r, calls } = pagedRasterizer(45);
    const s = fakeSession({ read: ocrByPage });
    const out = await createVisionWorker({
      rasterizer: r,
      laneOpen: () => true,
    }).work(change({}), s);
    expect(out).toBe('done');
    expect(calls[0]).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const e = s.enriched[0];
    expect(Object.keys(e.metadata.ocrProgress.pages)).toHaveLength(10);
    expect(e.metadata.ocrProgress.pageCount).toBe(45);
    expect(e.metadata.extraction).toBeUndefined();
    expect(e.markdown).toContain('--- page 10 ---');
  });

  it('resumes from ocrProgress and finishes on the last window', async () => {
    const { r, calls } = pagedRasterizer(12);
    const s = fakeSession({ read: ocrByPage });
    const prior = {
      pageCount: 12,
      pages: Object.fromEntries(
        [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => [
          String(n),
          `page text ${n} `.repeat(5),
        ]),
      ),
    };
    const out = await createVisionWorker({
      rasterizer: r,
      laneOpen: () => true,
    }).work(withProgress(prior), s);
    expect(out).toBe('done');
    expect(calls[0]).toEqual([11, 12]);
    const e = s.enriched[0];
    expect(e.metadata.extraction.engine).toBe('local-ocr');
    expect(e.metadata).toHaveProperty('ocrProgress', undefined);
    expect(e.markdown.indexOf('page text 1 ')).toBeLessThan(
      e.markdown.indexOf('page text 12 '),
    );
  });

  it('caps at MAX_OCR_PAGES and records pagesSkipped', async () => {
    const { r } = pagedRasterizer(250);
    const done = Object.fromEntries(
      Array.from({ length: 190 }, (_, i) => [String(i + 1), 'x '.repeat(30)]),
    );
    const s = fakeSession({ read: ocrByPage });
    await createVisionWorker({ rasterizer: r, laneOpen: () => true }).work(
      withProgress({ pageCount: 250, pages: done }),
      s,
    );
    expect(s.enriched[0].metadata.extraction.pagesSkipped).toBe(50);
  });

  it('a PDF over the eager cap logs one memory-probe line per window', async () => {
    const { r } = pagedRasterizer(25);
    const logs: string[] = [];
    const s = fakeSession({
      read: ocrByPage,
      fetchBytes: async () => new Uint8Array(MAX_LOCAL_BINARY_BYTES + 1),
      log: (_l, m) => logs.push(m),
    });
    await createVisionWorker({ rasterizer: r, laneOpen: () => true }).work(
      change({}),
      s,
    );
    expect(
      logs.filter((m) => m.startsWith('mem: ocr window 1-10 ')),
    ).toHaveLength(1);
  });

  it('a page the rasterizer never returns is recorded empty, so the doc still completes', async () => {
    // kia-vision skips a page CGPDFDocument cannot load; without this the
    // missing page is re-requested by every window forever.
    const rasterizer: Rasterizer = {
      pdfToPngs: jest.fn(async (_b, { pages }) => ({
        pageCount: 3,
        pages: pages
          .filter((n) => n !== 2 && n <= 3)
          .map((n) => ({ page: n, png: new Uint8Array([n]) })),
      })),
    };
    const s = fakeSession({ read: ocrByPage, see: async () => 'desc' });
    const out = await createVisionWorker({
      rasterizer,
      laneOpen: () => true,
    }).work(change({}), s);
    expect(out).toBe('done');
    expect(s.enriched).toHaveLength(1);
    expect(s.enriched[0].metadata.extraction).toBeDefined();
    expect(s.enriched[0].metadata).toHaveProperty('ocrProgress', undefined);
  });

  it('a deferred window drops the bytes cache (no 100 MiB held while parked)', async () => {
    const { r } = pagedRasterizer(25);
    const fetchBytes = jest.fn(async () => new Uint8Array(100));
    const worker = createVisionWorker({ rasterizer: r, laneOpen: () => true });
    const failing = fakeSession({
      read: async () => {
        throw new Error('helper crashed');
      },
      fetchBytes,
    });
    expect(await worker.work(change({}), failing)).toBe('defer');
    await worker.work(change({}), fakeSession({ read: ocrByPage, fetchBytes }));
    expect(fetchBytes).toHaveBeenCalledTimes(2);
  });

  it('fetches bytes once across consecutive windows of the same doc', async () => {
    const { r } = pagedRasterizer(25);
    const fetchBytes = jest.fn(async () => new Uint8Array(100));
    const worker = createVisionWorker({ rasterizer: r, laneOpen: () => true });
    const s1 = fakeSession({ read: ocrByPage, fetchBytes });
    await worker.work(change({}), s1);
    const s2 = fakeSession({ read: ocrByPage, fetchBytes });
    await worker.work(withProgress(s1.enriched[0].metadata.ocrProgress), s2);
    expect(fetchBytes).toHaveBeenCalledTimes(1);
  });

  it('a thin whole-doc OCR still runs VLM pass 2 on the first ≤20 pages', async () => {
    const { r, calls } = pagedRasterizer(3);
    const see = jest.fn(async () => 'desc');
    const s = fakeSession({ read: async () => '', see });
    await createVisionWorker({ rasterizer: r, laneOpen: () => true }).work(
      change({}),
      s,
    );
    expect(see).toHaveBeenCalledTimes(3);
    expect(calls[calls.length - 1]).toEqual([1, 2, 3]);
  });

  it('the VLM completion keeps OCR text of pages beyond the first 20, and pagesSkipped', async () => {
    const { r } = pagedRasterizer(230);
    // 199 pages already done with a whisper of text; total stays under the sufficiency bar
    const done = Object.fromEntries(
      Array.from({ length: 199 }, (_, i) => [
        String(i + 1),
        i === 149 ? 'p150' : '',
      ]),
    );
    const s = fakeSession({ read: async () => '', see: async () => 'desc' });
    await createVisionWorker({ rasterizer: r, laneOpen: () => true }).work(
      withProgress({ pageCount: 230, pages: done }),
      s,
    );
    const e = s.enriched[0];
    expect(e.metadata.extraction.engine).toBe('local-ocr+vlm');
    expect(e.metadata.extraction.pagesSkipped).toBe(30);
    expect(e.markdown).toContain('p150');
    expect(e.metadata).toHaveProperty('ocrProgress', undefined);
  });

  it('no read provider: first window marks pages empty and goes straight to the VLM', async () => {
    const { r } = pagedRasterizer(5);
    const see = jest.fn(async () => 'desc');
    const s = fakeSession({
      read: async () => {
        throw new NoProviderError('read');
      },
      see,
    });
    expect(
      await createVisionWorker({ rasterizer: r, laneOpen: () => true }).work(
        change({}),
        s,
      ),
    ).toBe('done');
    expect(see).toHaveBeenCalledTimes(5);
    expect(s.enriched[0].metadata.extraction.engine).toBe('local-ocr+vlm');
  });
});

describe('needs-ocr: only the listed pages', () => {
  function pagedRasterizer(pageCount: number) {
    const calls: number[][] = [];
    const r: Rasterizer = {
      pdfToPngs: jest.fn(async (_b, { pages }) => {
        calls.push(pages);
        return {
          pageCount,
          pages: pages
            .filter((n) => n <= pageCount)
            .map((n) => ({ page: n, png: new Uint8Array([n]) })),
        };
      }),
    };
    return { r, calls };
  }
  const needsOcr = (pages: number[], extra: Record<string, unknown> = {}) =>
    change({
      markdown: 'layer text',
      metadata: {
        ...baseDoc.metadata,
        mime: 'application/pdf',
        conversion: { status: 'needs-ocr', pages, quality: 1 },
        ...extra,
      },
    });

  it('OCRs only the listed pages and merges them with the text layer in page order, no VLM', async () => {
    const { r, calls } = pagedRasterizer(4);
    const see = jest.fn();
    const fetchBytes = async () =>
      multiPagePdf([
        { text: ['one one one one one one'] },
        { scan: true },
        { scan: true },
        { text: ['four four four four four'] },
      ]);
    const s = fakeSession({
      read: async (png: Uint8Array) => `ocr page ${png[0]} text`,
      see,
      fetchBytes,
    });
    expect(
      await createVisionWorker({ rasterizer: r, laneOpen: () => true }).work(
        needsOcr([2, 3]),
        s,
      ),
    ).toBe('done');
    expect(calls).toEqual([[2, 3]]);
    expect(see).not.toHaveBeenCalled();
    const md = s.enriched[0].markdown as string;
    expect(md.indexOf('one one')).toBeLessThan(md.indexOf('ocr page 2'));
    expect(md.indexOf('ocr page 3')).toBeLessThan(md.indexOf('four four'));
    expect(s.enriched[0].metadata.extraction.engine).toBe('local-ocr');
  });
  it("empty OCR for a page keeps that page's text-layer text", async () => {
    const { r } = pagedRasterizer(2);
    const fetchBytes = async () =>
      multiPagePdf([{ text: PROSE_LINES }, { text: shifted(PROSE_LINES) }]);
    const s = fakeSession({ read: async () => '', fetchBytes });
    await createVisionWorker({ rasterizer: r, laneOpen: () => true }).work(
      needsOcr([2]),
      s,
    );
    expect(s.enriched[0].markdown).toContain(
      shifted(PROSE_LINES)[0].slice(0, 20),
    );
  });
  it('no read provider → defer, text untouched', async () => {
    const { r } = pagedRasterizer(2);
    const s = fakeSession({
      read: async () => {
        throw new NoProviderError('read');
      },
      fetchBytes: async () =>
        multiPagePdf([{ text: PROSE_LINES }, { scan: true }]),
    });
    expect(
      await createVisionWorker({ rasterizer: r, laneOpen: () => true }).work(
        needsOcr([2]),
        s,
      ),
    ).toBe('defer');
    expect(s.enriched).toEqual([]);
  });
  it('60 pages, bad pages 3/17/41/58: resumes from ocrProgress after a restart and renders every page in order', async () => {
    const pages = Array.from({ length: 60 }, (_, i) =>
      [3, 17, 41, 58].includes(i + 1)
        ? { scan: true }
        : { text: [`body of page ${i + 1} here`] },
    ) as never;
    const bytes = multiPagePdf(pages);
    const { r, calls } = pagedRasterizer(60);
    const prior = { pageCount: 60, pages: { 3: 'ocr3', 17: 'ocr17' } };
    // fresh worker = "process restarted": empty cache
    const s = fakeSession({
      read: async (png: Uint8Array) => `ocr${png[0]}`,
      fetchBytes: async () => bytes,
    });
    await createVisionWorker({ rasterizer: r, laneOpen: () => true }).work(
      needsOcr([3, 17, 41, 58], { ocrProgress: prior }),
      s,
    );
    expect(calls).toEqual([[41, 58]]);
    const md = s.enriched[0].markdown as string;
    expect(md.indexOf('body of page 2 ')).toBeLessThan(md.indexOf('ocr3'));
    expect(md.indexOf('ocr58')).toBeLessThan(md.indexOf('body of page 59 '));
  });
  it('MAX_OCR_PAGES caps the number of listed pages and records pagesSkipped', async () => {
    const listed = Array.from({ length: 250 }, (_, i) => i + 1);
    const done = Object.fromEntries(
      listed.slice(0, 200).map((n) => [String(n), `o${n}`]),
    );
    const { r, calls } = pagedRasterizer(250);
    const s = fakeSession({
      read: async () => 'x',
      fetchBytes: async () =>
        multiPagePdf(
          Array.from({ length: 250 }, () => ({ scan: true })) as never,
        ),
    });
    await createVisionWorker({ rasterizer: r, laneOpen: () => true }).work(
      needsOcr(listed, { ocrProgress: { pageCount: 250, pages: done } }),
      s,
    );
    expect(calls).toEqual([]); // nothing left within the cap
    expect(s.enriched[0].metadata.extraction.pagesSkipped).toBe(50);
  });

  it('no read provider: later needs-ocr docs defer WITHOUT fetching until the retry window passes', async () => {
    const { r } = pagedRasterizer(2);
    const fetchBytes = jest.fn(async () =>
      multiPagePdf([{ text: PROSE_LINES }, { scan: true }]),
    );
    const s = fakeSession({
      read: async () => {
        throw new NoProviderError('read');
      },
      fetchBytes,
    });
    const w = createVisionWorker({ rasterizer: r, laneOpen: () => true });
    expect(await w.work(needsOcr([2]), s)).toBe('defer');
    expect(await w.work(needsOcr([2], { filename: 'other.pdf' }), s)).toBe(
      'defer',
    );
    expect(fetchBytes).toHaveBeenCalledTimes(1);
  });
  it('a listed page the rasterizer skips does not loop: the doc completes with its text-layer text', async () => {
    const skipping = {
      pdfToPngs: jest.fn(async (_b: Uint8Array, o: { pages: number[] }) => ({
        pageCount: 3,
        pages: o.pages
          .filter((n) => n !== 2)
          .map((n) => ({ page: n, png: new Uint8Array([n]) })),
      })),
    };
    const s = fakeSession({
      read: async () => 'ocr',
      fetchBytes: async () =>
        multiPagePdf([
          { text: PROSE_LINES },
          { text: shifted(PROSE_LINES) },
          { scan: true },
        ]),
    });
    expect(
      await createVisionWorker({
        rasterizer: skipping as never,
        laneOpen: () => true,
      }).work(needsOcr([2, 3]), s),
    ).toBe('done');
    expect(s.enriched[0].metadata.extraction.engine).toBe('local-ocr');
    expect(s.enriched[0].markdown).toContain(
      shifted(PROSE_LINES)[0].slice(0, 20),
    );
  });

  it('keeps text-layer text beyond 1M chars when rendering needs-ocr pages', async () => {
    const big = Array.from(
      { length: 1700 },
      () => 'Vertragstext der Parteien Absatz eins zwei drei vier fuenf sechs',
    ); // ~110 KB per page
    const pages = Array.from({ length: 12 }, (_, i) =>
      i === 11 ? { scan: true as const } : { text: [...big, `ENDE${i + 1}`] },
    );
    const { r } = pagedRasterizer(12);
    const s = fakeSession({
      read: async () => 'ocr12',
      fetchBytes: async () => multiPagePdf(pages) as never,
    });
    await createVisionWorker({ rasterizer: r, laneOpen: () => true }).work(
      needsOcr([12]),
      s,
    );
    const md = s.enriched.at(-1)!.markdown as string;
    expect(md.length).toBeGreaterThan(1_000_000);
    expect(md).toContain('ENDE11');
    expect(md).toContain('ocr12');
  });
});

describe('a dead VLM never strands a doc whose OCR ran (windows-ocr §3)', () => {
  const thinPdf = (pageCount = 2): Rasterizer => ({
    pdfToPngs: jest.fn(async (_b, { pages }) => ({
      pageCount,
      pages: pages
        .filter((n) => n <= pageCount)
        .map((n) => ({ page: n, png: new Uint8Array([n]) })),
    })),
  });
  const spawnErr = async (): Promise<string> => {
    throw Object.assign(new Error('spawn llama-server ENOENT'), {
      code: 'ENOENT',
    });
  };
  const worker = (r: Rasterizer = thinPdf()) =>
    createVisionWorker({ rasterizer: r, laneOpen: () => true });

  it('a real VLM failure counts; the 3rd completes OCR-only with vlm: unavailable', async () => {
    const bump = jest
      .fn()
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(3);
    const w = worker();
    const mk = () =>
      fakeSession({ read: async () => 'few', see: spawnErr, bump });
    expect(await w.work(change({}), mk())).toBe('defer');
    expect(await w.work(change({}), mk())).toBe('defer');
    const s3 = mk();
    expect(await w.work(change({}), s3)).toBe('done');
    expect(bump).toHaveBeenCalledWith('vlm');
    expect(s3.enriched[0].metadata.extraction).toMatchObject({
      engine: 'local-ocr',
      vlm: 'unavailable',
    });
    expect(s3.enriched[0].markdown).toContain('few');
  });
  it('LaneClosedError never counts', async () => {
    const bump = jest.fn();
    const s = fakeSession({
      read: async () => 'few',
      see: async () => {
        throw new LaneClosedError();
      },
      bump,
    });
    expect(await worker().work(change({}), s)).toBe('defer');
    expect(bump).not.toHaveBeenCalled();
  });
  it('NoProviderError(see) while a see provider may become ready never counts', async () => {
    const bump = jest.fn();
    const s = fakeSession({
      read: async () => 'few',
      see: async () => {
        throw new NoProviderError('see');
      },
      bump,
      mayBecomeReady: () => true,
    });
    expect(await worker().work(change({}), s)).toBe('defer');
    expect(bump).not.toHaveBeenCalled();
  });
  it('NoProviderError(see) with nothing that can become ready DOES count', async () => {
    const bump = jest.fn(async () => 3);
    const s = fakeSession({
      read: async () => 'few',
      see: async () => {
        throw new NoProviderError('see');
      },
      bump,
      mayBecomeReady: () => false,
    });
    expect(await worker().work(change({}), s)).toBe('done');
    expect(s.enriched[0].metadata.extraction.vlm).toBe('unavailable');
  });
  it('no read provider (pass 1 never ran): keeps deferring even after 3 VLM failures', async () => {
    const s = fakeSession({
      read: async () => {
        throw new NoProviderError('read');
      },
      see: spawnErr,
      bump: async () => 9,
    });
    expect(await worker().work(change({}), s)).toBe('defer');
    expect(s.enriched).toEqual([]);
  });
  it('a rasterizer error before the VLM is not a VLM failure', async () => {
    let call = 0;
    const r: Rasterizer = {
      pdfToPngs: jest.fn(async (_b, { pages }) => {
        call += 1;
        if (call > 1) throw new Error('pdfium broke');
        return {
          pageCount: 2,
          pages: pages.map((n) => ({ page: n, png: new Uint8Array([n]) })),
        };
      }),
    };
    const bump = jest.fn(async () => 3);
    const s = fakeSession({ read: async () => 'few', see: spawnErr, bump });
    expect(await worker(r).work(change({}), s)).toBe('defer');
    expect(bump).not.toHaveBeenCalled();
  });
  it('non-VLM-decodable TIFF: defers when OCR did not run, completes when it did', async () => {
    const tiff = change({
      title: 'scan.tif',
      type: 'file',
      metadata: { mime: 'image/tiff', filename: 'scan.tif', sizeBytes: 50_000 },
    });
    const w = worker();
    expect(
      await w.work(
        tiff,
        fakeSession({
          read: async () => {
            throw new NoProviderError('read');
          },
        }),
      ),
    ).toBe('defer');
    const s = fakeSession({ read: async () => 'tiff text' });
    expect(await w.work(tiff, s)).toBe('done');
    expect(s.enriched[0].markdown).toContain('tiff text');
  });
  it('OCR lost between windows: a resumed doc defers instead of completing with unread pages', async () => {
    const prior = {
      pageCount: 25,
      pages: Object.fromEntries(
        Array.from({ length: 10 }, (_, i) => [
          String(i + 1),
          'plenty of text '.repeat(20),
        ]),
      ),
    };
    const see = jest.fn();
    const s = fakeSession({
      read: async () => {
        throw new NoProviderError('read');
      },
      see,
    });
    expect(
      await worker(thinPdf(25)).work(
        change({
          metadata: { ...baseDoc.metadata, ocrProgress: prior },
        }),
        s,
      ),
    ).toBe('defer');
    expect(s.enriched).toEqual([]);
    expect(see).not.toHaveBeenCalled();
  });
  it('a text-poor PNG goes to the VLM as a PNG, never through the PDF rasterizer', async () => {
    const pdfToPngs = jest.fn();
    const see = jest.fn(async () => 'a chart of sales');
    const png = change({
      title: 'chart.png',
      type: 'file',
      metadata: { mime: 'image/png', filename: 'chart.png', sizeBytes: 50_000 },
    });
    const s = fakeSession({ read: async () => 'few', see });
    expect(
      await createVisionWorker({
        rasterizer: { pdfToPngs } as never,
        laneOpen: () => true,
      }).work(png, s),
    ).toBe('done');
    expect(pdfToPngs).not.toHaveBeenCalled();
    expect((see.mock.calls[0] as unknown[])[2]).toMatchObject({
      mime: 'image/png',
    });
    expect(s.enriched[0].metadata.extraction.engine).toBe('local-ocr+vlm');
  });
});

describe('a read provider still starting (selftest pending) is waited for', () => {
  const pdf = (pageCount = 2): Rasterizer => ({
    pdfToPngs: jest.fn(async (_b, { pages }) => ({
      pageCount,
      pages: pages
        .filter((n) => n <= pageCount)
        .map((n) => ({ page: n, png: new Uint8Array([n]) })),
    })),
  });
  const starting = (over: Partial<WorkerSession> = {}) =>
    fakeSession({
      read: async () => {
        throw new NoProviderError('read');
      },
      mayBecomeReady: (kind) => kind === 'read',
      ...over,
    });

  it('a scanned PDF defers instead of completing VLM-only', async () => {
    const see = jest.fn(async () => 'desc');
    const s = starting({ see });
    expect(
      await createVisionWorker({
        rasterizer: pdf(),
        laneOpen: () => true,
      }).work(change({}), s),
    ).toBe('defer');
    expect(see).not.toHaveBeenCalled();
    expect(s.enriched).toEqual([]);
  });
  it('an image defers instead of completing VLM-only', async () => {
    const see = jest.fn(async () => 'desc');
    const s = starting({ see });
    const png = change({
      title: 'a.png',
      type: 'file',
      metadata: { mime: 'image/png', filename: 'a.png', sizeBytes: 50_000 },
    });
    expect(
      await createVisionWorker({
        rasterizer: pdf(),
        laneOpen: () => true,
      }).work(png, s),
    ).toBe('defer');
    expect(see).not.toHaveBeenCalled();
  });
  it('a needs-ocr PDF defers WITHOUT parking every needs-ocr doc for the retry window', async () => {
    const listed = (id: string) =>
      change({
        id,
        markdown: PROSE_LINES.join('\n'),
        metadata: {
          ...baseDoc.metadata,
          conversion: { status: 'needs-ocr', pages: [1], quality: 1 },
        },
      });
    const bytes = multiPagePdf([{ text: shifted(PROSE_LINES) }]);
    const w = createVisionWorker({ rasterizer: pdf(1), laneOpen: () => true });
    expect(
      await w.work(listed('d1'), starting({ fetchBytes: async () => bytes })),
    ).toBe('defer');
    // OCR is up now: the next needs-ocr doc is OCR'd at once, not parked.
    const read = jest.fn(async () => 'ocr text of page one '.repeat(5));
    const s2 = fakeSession({ read, fetchBytes: async () => bytes });
    expect(await w.work(listed('d2'), s2)).toBe('done');
    expect(read).toHaveBeenCalled();
  });
});
