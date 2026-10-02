import type {
  Change,
  Document,
  Worker,
  WorkerSession,
  WorkOutcome,
} from '@shared/contracts';

import { capMarkdown, parsePdfPages } from '@main/core/engine/convert';
import { LaneClosedError, NoProviderError } from '@main/core/inference';
import { MAX_LOCAL_BINARY_BYTES } from '@shared/file-indexability';

import { logPeak } from '../mem-probe';

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

const READ_RETRY_MS = 25 * 60_000;

/** needs-ocr rendering: every page in order, text-layer or OCR. Not
 *  mergeExtraction: its 1M-char cap and "Text content (OCR)" labels are for
 *  VLM output; a long text-layer PDF keeps up to MAX_MARKDOWN_CHARS. */
function renderListedPages(texts: string[]): string {
  const body =
    texts.length > 1
      ? texts.map((t, i) => `--- page ${i + 1} ---\n\n${t.trim()}`).join('\n\n')
      : (texts[0] ?? '').trim();
  return capMarkdown(body).markdown;
}

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
/** One image handed to the VLM pass. */
type VlmImage = { page: number; bytes: Uint8Array; mime: string };

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
  // rssBefore: the memory probe's baseline, taken before the doc's first
  // fetch — one per document, so growth across windows shows up.
  // layer: the per-page text-layer text of a needs-ocr PDF, parsed once.
  let cache: {
    key: string;
    bytes: Uint8Array;
    rssBefore: number;
    layer?: string[];
  } | null = null;
  // One probe per cadence across ALL needs-ocr docs while no read provider
  // exists (a Linux host, or Windows before OCR ships). Without it every
  // needs-ocr doc re-downloads, parses and rasterizes every 30 min.
  let readUnavailableUntil = 0;
  const keyOf = (d: Document) => `${d.id}:${d.contentHash}`;

  /** Pass 2 — VLM describe over prepared images (PNG pages of a PDF, or the
   *  image itself). Descriptions land on the matching `pages` entries, so
   *  pages without an image keep their OCR text. A real VLM failure counts
   *  (durable, change-free `bump('vlm')`); after 3, a doc whose OCR ran
   *  completes OCR-only instead of re-driving forever. */
  async function vlmPass(
    session: WorkerSession,
    pages: PageResult[],
    images: () => Promise<VlmImage[]>,
    complete: (
      engine: string,
      pages: PageResult[],
      extra?: Record<string, unknown>,
    ) => WorkOutcome,
    ocrRan: boolean,
  ): Promise<WorkOutcome> {
    // Loading the images is not a VLM call: a rasterizer error never counts.
    let pageImages: VlmImage[];
    try {
      pageImages = await images();
    } catch {
      return 'defer';
    }
    try {
      // Who described each page: a routed task may be answered remotely
      // for some pages and locally for others (fallback mid-document).
      const byModel = new Map<
        string,
        { providerId: string; modelId: string; pages: number }
      >();
      for (const { page: n, bytes: img, mime: imgMime } of pageImages) {
        // Pass 2 ONLY. Pass 1 (OCR) deliberately reads the full-size
        // page: transcription accuracy scales with resolution, and the OCR
        // helper takes a temp-file PATH rather than a base64 payload, so it
        // costs no JS heap. The VLM is the one that pays three full-size
        // heap strings per call — and the one that discards the extra
        // pixels anyway.
        // eslint-disable-next-line no-await-in-loop
        const page = await downscale(img, imgMime);
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
    } catch (err) {
      // Ordinary scheduling: the window closed mid-run. Never a failure.
      if (err instanceof LaneClosedError) return 'defer';
      // A see provider is downloading / will auto-install: wait for it.
      if (err instanceof NoProviderError && session.mayBecomeReady('see'))
        return 'defer';
      // A real VLM failure (incl. a NoProviderError nothing can ever fix).
      const n = await session.bump('vlm');
      if (n >= 3 && ocrRan)
        return complete('local-ocr', pages, { vlm: 'unavailable' });
      return 'defer'; // pass 1 never ran → stay recoverable for when OCR appears
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
      // Only a 'done' window is followed at once by the next one; anything
      // else parks the doc (re-drive, lane window), so never hold its bytes
      // (up to MAX_PDF_BYTES) while it waits.
      let out: WorkOutcome | undefined;
      try {
        out = await workOne(change, session);
        return out;
      } finally {
        if (out !== 'done') cache = null;
      }
    },
  };

  async function workOne(
    change: Change,
    session: WorkerSession,
  ): Promise<WorkOutcome> {
    if (change.kind !== 'document') return 'skip';
    const doc = change.document;
    // Outside the processing window: park instead of blocking on the lane
    // gate — a parked ledger row is free, a blocked work() stalls the tail.
    if (!deps.laneOpen()) return 'defer';

    const pdf = isPdfDoc(doc);
    // needs-ocr: the parser kept the text layer and listed the pages whose
    // layer is missing or garbled; only those are OCR'd, never the VLM.
    const conv = (doc.metadata as { conversion?: unknown }).conversion as
      | { status?: unknown; pages?: unknown }
      | undefined;
    const listedAll =
      pdf && conv?.status === 'needs-ocr' && Array.isArray(conv.pages)
        ? [
            ...new Set(
              conv.pages.filter(
                (n): n is number => Number.isInteger(n) && n >= 1,
              ),
            ),
          ].sort((a, b) => a - b)
        : null;
    const listed = listedAll?.slice(0, MAX_OCR_PAGES) ?? null;
    if (listed && Date.now() < readUnavailableUntil) return 'defer';
    const key = keyOf(doc);
    let bytes = cache?.key === key ? cache.bytes : null;
    if (!bytes) {
      const rssBefore = process.memoryUsage().rss;
      // A fetch that fails right now (source still registering, offline)
      // throws FetchDeferredError, which the engine parks for the re-drive.
      bytes = await session.fetchBytes(doc);
      if (!bytes) return 'skip'; // source can't serve bytes — terminal
      if (bytes.length > (pdf ? MAX_PDF_BYTES : MAX_IMAGE_BYTES)) return 'skip';
      cache = pdf ? { key, bytes, rssBefore } : null;
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
      let ocrFailed = false;
      try {
        ocrText = await session.read(bytes, { mime });
      } catch (err) {
        // A crashed OCR helper is transient — DEFER so the re-drive can
        // recover the doc, rather than silently degrading to pass 2 (or,
        // worse, an OCR-less permanent record). LaneClosedError (window
        // closed mid-run) defers the same way. Only a genuine "no read
        // provider" (e.g. non-mac host) falls through to pass 2.
        if (!(err instanceof NoProviderError)) return 'defer';
        ocrFailed = true;
      }
      const pages: PageResult[] = [{ page: 1, ocrText }];
      if ((ocrText ?? '').replace(/\s+/g, '').length >= OCR_SUFFICIENT_CHARS)
        return complete('local-ocr', pages);
      // VLM-decodable guard: a text-poor image whose format llama.cpp's
      // stb_image cannot decode (HEIC/WebP/TIFF…) would re-drive pass 2
      // forever — fetch+OCR+VLM every cadence, uncapped, since the `see`
      // call fails on every attempt. Complete with the OCR-only result
      // (whatever pass 1 produced) instead of deferring. PDFs rasterize to
      // PNG, so they're exempt. Only when pass 1 actually ran: with no OCR
      // provider, completing would bury the image with no text — defer
      // until one appears.
      if (!isVlmDecodable(doc)) {
        if (ocrFailed) return 'defer';
        return complete('local-ocr', pages);
      }
      const image = bytes;
      return vlmPass(
        session,
        pages,
        async () => [{ page: 1, bytes: image, mime: mime ?? 'image/png' }],
        complete,
        !ocrFailed,
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
    // One windowed loop, two candidate lists: the listed pages, or 1..limit.
    const candidates = listed ?? Array.from({ length: limit }, (_, i) => i + 1);
    const next = candidates
      .filter((n) => !(String(n) in done))
      .slice(0, OCR_WINDOW);

    // Only the listed path can reach an empty window (all listed pages done).
    const raster = next.length
      ? await deps.rasterizer.pdfToPngs(bytes, { pages: next })
      : null;
    const pageCount = raster?.pageCount ?? prog?.pageCount ?? 0;
    const cap = Math.min(pageCount, MAX_OCR_PAGES);
    // Pass 1 — OCR, one window. ocrRan: false once OCR turned out absent.
    let ocrRan = true;
    for (const { page, png } of raster?.pages ?? []) {
      try {
        // eslint-disable-next-line no-await-in-loop
        done[String(page)] =
          (await session.read(png, { mime: 'image/png' })) ?? '';
      } catch (err) {
        // Same transient-vs-absent split as the image path above.
        if (!(err instanceof NoProviderError)) return 'defer';
        if (listed) {
          // No VLM for needs-ocr, and its text is already indexed: park
          // every needs-ocr doc for a while instead of re-fetching each.
          readUnavailableUntil = Date.now() + READ_RETRY_MS;
          return 'defer';
        }
        // No OCR provider at all: mark every page empty (no rendering) and
        // fall through. chars = 0 < OCR_SUFFICIENT_CHARS → the VLM pass.
        ocrRan = false;
        for (let n = 1; n <= cap; n += 1) done[String(n)] ??= '';
        break;
      }
    }
    // A requested page the rasterizer did not return (kia-vision skips a
    // page it cannot load) is recorded empty — else every window would
    // re-request it and the doc would re-feed forever.
    // Listed pages come from pdf.js, page renders from pdfium: a listed page
    // pdfium cannot render is recorded empty too (it keeps its layer text).
    for (const n of next) if (listed || n <= cap) done[String(n)] ??= '';
    if (cache && next.length && bytes.length > MAX_LOCAL_BINARY_BYTES)
      logPeak(
        session,
        `ocr window ${next[0]}-${next.at(-1)}`,
        bytes.length,
        cache.rssBefore,
      );
    if (listed) {
      // The text layer, parsed lazily (only when rendering, so a deferred doc
      // never pays for it); OCR replaces a page's layer text only when it
      // read something.
      let layer: string[];
      try {
        layer = cache?.layer ?? (await parsePdfPages(bytes));
      } catch {
        return 'defer';
      }
      if (layer.length === 0) return 'defer'; // never render from nothing
      if (cache) cache.layer = layer;
      const texts = layer.map((t, i) => {
        const o = done[String(i + 1)];
        return o && o.trim() ? o : t;
      });
      if (listed.some((n) => !(String(n) in done))) {
        session.enrich({
          documentId: doc.id,
          markdown: renderListedPages(texts),
          metadata: { ocrProgress: { pageCount, pages: done } },
        });
        return 'done';
      }
      cache = null;
      const skipped = Math.max(0, (listedAll?.length ?? 0) - MAX_OCR_PAGES);
      session.enrich({
        documentId: doc.id,
        markdown: renderListedPages(texts),
        metadata: {
          ocrProgress: undefined,
          extraction: {
            engine: 'local-ocr',
            at: new Date().toISOString(),
            ...(skipped ? { pagesSkipped: skipped } : {}),
          },
        },
      });
      return 'done';
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
    if (ocrRan && chars >= OCR_SUFFICIENT_CHARS)
      return finish('local-ocr', pagesOut());
    // Resumed doc, and OCR vanished between windows: the '' fills are pages
    // never read. Completing now would make them unsearchable for good.
    if (!ocrRan && prog) return 'defer';
    const first = Array.from(
      { length: Math.min(pageCount, MAX_PAGES) },
      (_, i) => i + 1,
    );
    const pdfBytes = bytes;
    const images = async (): Promise<VlmImage[]> =>
      (await deps.rasterizer.pdfToPngs(pdfBytes, { pages: first })).pages.map(
        (p) => ({ page: p.page, bytes: p.png, mime: 'image/png' }),
      );
    return vlmPass(session, pagesOut(), images, finish, ocrRan);
  }
}
