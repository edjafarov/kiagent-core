import type {
  Change,
  Document,
  Worker,
  WorkerSession,
  WorkOutcome,
} from '@shared/contracts';

import { NoProviderError } from '@main/core/inference';

import {
  classifyDocument,
  isPdfDoc,
  isVlmDecodable,
  MAX_IMAGE_BYTES,
  MAX_OCR_PAGES,
  MAX_PAGES,
  MAX_PDF_BYTES,
  OCR_SUFFICIENT_CHARS,
  OCR_WINDOW,
} from './classify';
import { passthroughDownscaler, type ImageDownscaler } from './downscale';
import { INDEXING_PROMPT, mergeExtraction } from './merge';
import type { PageResult } from './merge';
import type { Rasterizer } from './rasterize';

/** Windowed OCR state on a PDF in flight: OCR text per page read so far
 *  (keys are 1-based page numbers; `''` = read, nothing found). */
interface OcrProgress {
  pageCount: number;
  pages: Record<string, string>;
}

/**
 * The two-pass vision worker. Pass 1 = OCR via `read` (free/native where
 * available); a text-rich result enriches immediately. Text-poor documents
 * fall through to pass 2 = VLM `see`; when no see-provider is ready the
 * change DEFERS and the scheduled re-drive retries it — at-least-once, so
 * a re-driven change simply re-runs both passes.
 *
 * PDFs OCR in windows of OCR_WINDOW pages (up to MAX_OCR_PAGES): each run
 * reads the next window, writes `ocrProgress` + the markdown so far, and
 * returns done; that enrich re-feeds the doc, which classifies as a
 * candidate while `ocrProgress` is set, so the next window follows.
 */
export function createVisionWorker(deps: {
  rasterizer: Rasterizer;
  laneOpen(): boolean;
  /** Clamps a page to the VLM's usable resolution before pass 2 encodes it.
   *  Optional so non-Electron hosts and tests get the identity function. */
  downscale?: ImageDownscaler;
}): Worker {
  const downscale = deps.downscale ?? passthroughDownscaler;
  // One doc's bytes, kept across its consecutive windows (the enrich of window
  // N re-feeds the doc immediately). Dropped on completion or a different doc.
  let cache: { key: string; bytes: Uint8Array } | null = null;
  const keyOf = (d: Document) => `${d.id}:${d.contentHash}`;

  /** Pass 2 — VLM describe over `pageImages` (only reachable when a
   *  see-provider is ready). Descriptions land on the matching `pages`
   *  entries, so pages without an image keep their OCR text. */
  async function vlmPass(
    session: WorkerSession,
    pages: PageResult[],
    pageImages: Array<{ page: number; png: Uint8Array }>,
    pageMime: string | undefined,
    complete: (
      engine: string,
      pages: PageResult[],
      extra?: Record<string, unknown>,
    ) => WorkOutcome,
  ): Promise<WorkOutcome> {
    try {
      // Who described each page: a routed task may be answered remotely
      // for some pages and locally for others (fallback mid-document).
      const byModel = new Map<
        string,
        { providerId: string; modelId: string; pages: number }
      >();
      for (const { page: n, png } of pageImages) {
        // Pass 2 ONLY. Pass 1 (OCR) deliberately reads the full-size
        // page: transcription accuracy scales with resolution, and the OCR
        // helper takes a temp-file PATH rather than a base64 payload, so it
        // costs no JS heap. The VLM is the one that pays three full-size
        // heap strings per call — and the one that discards the extra
        // pixels anyway.
        // eslint-disable-next-line no-await-in-loop
        const page = await downscale(png, pageMime);
        // eslint-disable-next-line no-await-in-loop
        const seen = await session.seeWithMeta(page.bytes, INDEXING_PROMPT, {
          mime: page.mime,
          task: 'vision.describe',
        });
        const entry = pages.find((p) => p.page === n);
        if (entry) entry.description = seen.text;
        else pages.push({ page: n, description: seen.text });
        const key = `${seen.providerId}\u0000${seen.modelId}`;
        const row = byModel.get(key) ?? {
          providerId: seen.providerId,
          modelId: seen.modelId,
          pages: 0,
        };
        row.pages += 1;
        byModel.set(key, row);
      }
      pages.sort((a, b) => (a.page ?? 0) - (b.page ?? 0));
      return complete('local-ocr+vlm', pages, {
        providers: [...byModel.values()],
      });
    } catch {
      return 'defer'; // model not installed/ready, or lane closed mid-run — the re-drive picks it up
    }
  }

  return {
    name: 'vision',
    version: 1,
    schedule: { every: '30m' }, // deferred re-drive cadence; the live tail always runs
    matches: (change: Change) =>
      change.kind === 'document' &&
      classifyDocument(change.document) === 'candidate',

    async work(change: Change, session: WorkerSession): Promise<WorkOutcome> {
      if (change.kind !== 'document') return 'skip';
      const doc = change.document;
      // Outside the processing window: park instead of blocking on the lane
      // gate — a parked ledger row is free, a blocked work() stalls the tail.
      if (!deps.laneOpen()) return 'defer';

      const pdf = isPdfDoc(doc);
      const key = keyOf(doc);
      let bytes = cache?.key === key ? cache.bytes : null;
      if (!bytes) {
        // A fetch that fails right now (source still registering, offline)
        // throws FetchDeferredError, which the engine parks for the re-drive.
        bytes = await session.fetchBytes(doc);
        if (!bytes) return 'skip'; // source can't serve bytes — terminal
        if (bytes.length > (pdf ? MAX_PDF_BYTES : MAX_IMAGE_BYTES))
          return 'skip';
        cache = pdf ? { key, bytes } : null;
      }

      const { mime } = doc.metadata as { mime?: string };
      const complete = (
        engine: string,
        pages: PageResult[],
        extra: Record<string, unknown> = {},
        pageCount = 1,
      ): WorkOutcome => {
        session.enrich({
          documentId: doc.id,
          markdown: mergeExtraction(pages),
          metadata: {
            ocrProgress: undefined,
            extraction: {
              engine,
              at: new Date().toISOString(),
              ...extra,
              ...(pageCount > MAX_OCR_PAGES
                ? { pagesSkipped: pageCount - MAX_OCR_PAGES }
                : {}),
            },
          },
        });
        return 'done';
      };

      if (!pdf) {
        // Single image: one OCR read, then the same sufficiency/VLM ladder.
        let ocrText: string | undefined;
        try {
          ocrText = await session.read(bytes, { mime });
        } catch (err) {
          // A crashed OCR helper is transient — DEFER so the re-drive can
          // recover the doc, rather than silently degrading to pass 2 (or,
          // worse, an OCR-less permanent record). LaneClosedError (window
          // closed mid-run) defers the same way. Only a genuine "no read
          // provider" (e.g. non-mac host) falls through to pass 2.
          if (!(err instanceof NoProviderError)) return 'defer';
        }
        const pages: PageResult[] = [{ page: 1, ocrText }];
        if ((ocrText ?? '').replace(/\s+/g, '').length >= OCR_SUFFICIENT_CHARS)
          return complete('local-ocr', pages);
        // VLM-decodable guard: a text-poor image whose format llama.cpp's
        // stb_image cannot decode (HEIC/WebP/TIFF…) would re-drive pass 2
        // forever — fetch+OCR+VLM every cadence, uncapped, since the `see`
        // call fails on every attempt. Complete with the OCR-only result
        // (whatever pass 1 produced) instead of deferring. PDFs rasterize to
        // PNG, so they're exempt.
        if (!isVlmDecodable(doc)) return complete('local-ocr', pages);
        return vlmPass(
          session,
          pages,
          [{ page: 1, png: bytes }],
          mime,
          complete,
        );
      }

      const prog =
        (doc.metadata as { ocrProgress?: OcrProgress }).ocrProgress ?? null;
      const done: Record<string, string> = { ...(prog?.pages ?? {}) };
      // First window: pageCount is unknown until the rasterizer reports it.
      const limit = Math.min(
        prog?.pageCount ?? Number.MAX_SAFE_INTEGER,
        MAX_OCR_PAGES,
      );
      const next: number[] = [];
      for (let n = 1; n <= limit && next.length < OCR_WINDOW; n += 1)
        if (!(String(n) in done)) next.push(n);

      const raster = await deps.rasterizer.pdfToPngs(bytes, { pages: next });
      const { pageCount } = raster;
      const cap = Math.min(pageCount, MAX_OCR_PAGES);
      // Pass 1 — OCR, one window.
      for (const { page, png } of raster.pages) {
        try {
          // eslint-disable-next-line no-await-in-loop
          done[String(page)] =
            (await session.read(png, { mime: 'image/png' })) ?? '';
        } catch (err) {
          // Same transient-vs-absent split as the image path above.
          if (!(err instanceof NoProviderError)) return 'defer';
          // No OCR provider at all: mark every page empty (no rendering) and
          // fall through. chars = 0 < OCR_SUFFICIENT_CHARS → the VLM pass.
          for (let n = 1; n <= cap; n += 1) done[String(n)] ??= '';
          break;
        }
      }
      const pagesOut = (): PageResult[] =>
        Object.keys(done)
          .map(Number)
          .sort((a, b) => a - b)
          .map((n) => ({ page: n, ocrText: done[String(n)] }));
      const remaining = Array.from({ length: cap }, (_, i) => i + 1).some(
        (n) => !(String(n) in done),
      );
      if (remaining) {
        session.enrich({
          documentId: doc.id,
          markdown: mergeExtraction(pagesOut()),
          metadata: { ocrProgress: { pageCount, pages: done } },
        });
        return 'done';
      }
      cache = null;
      // The ONE completion writer: every OCR'd page, page-ordered, with VLM
      // descriptions merged in where pass 2 ran.
      const finish: typeof complete = (engine, pages, extra) =>
        complete(engine, pages, extra, pageCount);
      const chars = Object.values(done).join('').replace(/\s+/g, '').length;
      if (chars >= OCR_SUFFICIENT_CHARS) return finish('local-ocr', pagesOut());
      const first = Array.from(
        { length: Math.min(pageCount, MAX_PAGES) },
        (_, i) => i + 1,
      );
      const images = (await deps.rasterizer.pdfToPngs(bytes, { pages: first }))
        .pages;
      return vlmPass(session, pagesOut(), images, 'image/png', finish);
    },
  };
}
