import type {
  Change,
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
  MAX_PAGES,
  MAX_PDF_BYTES,
  OCR_SUFFICIENT_CHARS,
} from './classify';
import { INDEXING_PROMPT, mergeExtraction } from './merge';
import type { PageResult } from './merge';
import type { Rasterizer } from './rasterize';

/**
 * The two-pass vision worker. Pass 1 = OCR via `read` (free/native where
 * available); a text-rich result enriches immediately. Text-poor documents
 * fall through to pass 2 = VLM `see`; when no see-provider is ready the
 * change DEFERS and the scheduled re-drive retries it — at-least-once, so
 * a re-driven change simply re-runs both passes.
 */
export function createVisionWorker(deps: {
  rasterizer: Rasterizer;
  laneOpen(): boolean;
}): Worker {
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
      const bytes = await session.fetchBytes(doc);
      if (!bytes) return 'skip'; // source can't serve bytes — terminal
      if (bytes.length > (pdf ? MAX_PDF_BYTES : MAX_IMAGE_BYTES)) return 'skip';

      const { mime } = doc.metadata as { mime?: string };
      const pages = pdf
        ? await deps.rasterizer.pdfToPngs(bytes, MAX_PAGES)
        : [bytes];
      const pageMime = pdf ? 'image/png' : mime;

      // Pass 1 — OCR.
      const ocr: Array<string | undefined> = [];
      let ocrFailed = false;
      for (const page of pages) {
        try {
          ocr.push(await session.read(page, { mime: pageMime }));
        } catch (err) {
          // A crashed OCR helper is transient — DEFER so the re-drive can
          // recover the doc, rather than silently degrading to pass 2 (or,
          // worse, an OCR-less permanent record). LaneClosedError (window
          // closed mid-run) defers the same way. Only a genuine "no read
          // provider" (e.g. non-mac host) falls through to pass 2.
          if (!(err instanceof NoProviderError)) return 'defer';
          ocrFailed = true;
          break;
        }
      }
      const ocrChars = ocr.join('').replace(/\s+/g, '').length;
      if (!ocrFailed && ocrChars >= OCR_SUFFICIENT_CHARS) {
        session.enrich({
          documentId: doc.id,
          markdown: mergeExtraction(
            pages.map((_, i): PageResult => ({ ocrText: ocr[i] })),
          ),
          metadata: {
            extraction: { engine: 'local-ocr', at: new Date().toISOString() },
          },
        });
        return 'done';
      }

      // VLM-decodable guard: a text-poor image whose format llama.cpp's
      // stb_image cannot decode (HEIC/WebP/TIFF…) would re-drive pass 2
      // forever — fetch+rasterize+OCR+VLM every cadence, uncapped, since the
      // `see` call fails on every attempt. Complete with the OCR-only result
      // (whatever pass 1 produced) instead of deferring. PDFs rasterize to
      // PNG, so they're exempt.
      if (!pdf && !isVlmDecodable(doc)) {
        session.enrich({
          documentId: doc.id,
          markdown: mergeExtraction(
            pages.map((_, i): PageResult => ({ ocrText: ocr[i] })),
          ),
          metadata: {
            extraction: { engine: 'local-ocr', at: new Date().toISOString() },
          },
        });
        return 'done';
      }

      // Pass 2 — VLM describe (only reachable when a see-provider is ready).
      try {
        const results: PageResult[] = [];
        for (let i = 0; i < pages.length; i += 1) {
          const description = await session.see(pages[i], INDEXING_PROMPT, {
            mime: pageMime,
          });
          results.push({ ocrText: ocr[i], description });
        }
        session.enrich({
          documentId: doc.id,
          markdown: mergeExtraction(results),
          metadata: {
            extraction: {
              engine: 'local-ocr+vlm',
              at: new Date().toISOString(),
            },
          },
        });
        return 'done';
      } catch {
        return 'defer'; // model not installed/ready, or lane closed mid-run — the re-drive picks it up
      }
    },
  };
}
