import type { Change, Document, WorkerSession } from '@shared/contracts';
import { NoProviderError } from '@main/core/inference';
import type { Rasterizer } from '../rasterize';
import { createVisionWorker } from '../vision-worker';

const baseDoc = {
  id: 'd',
  accountId: 'a',
  externalId: 'x',
  type: 'attachment',
  title: 'scan.pdf',
  markdown: null,
  metadata: { mime: 'application/pdf', sizeBytes: 50_000 },
  createdAt: null,
  parentId: null,
  contentHash: 'h',
  seq: 1,
  archivedAt: null,
  languages: [],
  ingestedAt: '2026-01-01',
  updatedAt: '2026-01-01',
} as Document;

function fakeSession(
  over: Partial<WorkerSession> = {},
): WorkerSession & { enriched: any[] } {
  const enriched: any[] = [];
  return {
    enriched,
    signal: new AbortController().signal,
    inference: async () => 'x',
    see: async () => 'a description of the page',
    read: async () => 'plenty of ocr text '.repeat(20), // > 200 chars
    hear: async () => 'a transcript',
    fetchBytes: async () => new Uint8Array(100_000),
    emit: () => {},
    enrich: (e) => enriched.push(e),
    log: () => {},
    ...over,
  };
}

const change = (doc: Partial<Document>) =>
  ({ seq: 1, kind: 'document', document: { ...baseDoc, ...doc } }) as Change;

it('OCR-sufficient PDF → done, enrich with per-page OCR, no `see` call', async () => {
  const session = fakeSession();
  const see = jest.spyOn(session, 'see');
  const rasterizer: Rasterizer = {
    pdfToPngs: jest.fn(async () => [new Uint8Array([1]), new Uint8Array([2])]),
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
    pdfToPngs: jest.fn(async () => [new Uint8Array([1])]),
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
    pdfToPngs: jest.fn(async () => [new Uint8Array([1])]),
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
    pdfToPngs: jest.fn(async () => [new Uint8Array([1])]),
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
    pdfToPngs: jest.fn(async () => [new Uint8Array([1])]),
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
    fetchBytes: async () => new Uint8Array(50 * 1024 * 1024 + 1),
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
