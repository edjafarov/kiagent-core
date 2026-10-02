import type { Change, Document, WorkerSession } from '@shared/contracts';
import { NoProviderError } from '@main/core/inference';
import { MAX_LOCAL_BINARY_BYTES } from '@shared/file-indexability';
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
