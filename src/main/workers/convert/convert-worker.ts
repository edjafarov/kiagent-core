import type {
  Change,
  Document,
  Worker,
  WorkerSession,
  WorkOutcome,
} from '@shared/contracts';
import {
  MAX_CLOUD_BINARY_BYTES,
  MAX_FETCH_BYTES,
  MAX_LOCAL_BINARY_BYTES,
} from '@shared/file-indexability';

import {
  capMarkdown,
  convertibleKind,
  needsOcrMarker,
  parseDetailed as realParse,
  type ConvertibleKind,
} from '@main/core/engine/convert';

import { logPeak } from '../mem-probe';

import {
  HAS_TEXT_CHARS,
  type ConversionOutcome,
  type ConversionStatus,
} from './outcome';

/** Largest file the worker fetches+parses, per kind: PDFs up to the fetch
 *  cap; everything else up to the LARGEST eager cap (cloud, 25 MiB) — their
 *  parsers inline images and are not hardened for huge inputs. The worker
 *  does not know the source's profile; a local file over ITS eager cap is
 *  `bytes: 'none'`, whose fetchBytes returns null without reading. */
export function convertCapFor(kind: ConvertibleKind): number {
  return kind === 'pdf' ? MAX_FETCH_BYTES : MAX_CLOUD_BINARY_BYTES;
}

interface ConvertMeta {
  mime?: unknown;
  filename?: unknown;
  sizeBytes?: unknown;
  /** Local-folder docs ingested before 2026-07 carry only this key. */
  size?: unknown;
  conversion?: unknown;
  extraction?: unknown;
}

const str = (v: unknown): string | undefined =>
  typeof v === 'string' ? v : undefined;
const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;

function fileName(doc: Document): string | undefined {
  return str((doc.metadata as ConvertMeta).filename) ?? doc.title ?? undefined;
}

/** A document the converter can parse that has no text and no outcome yet —
 *  whichever source it came from. Sources that push bytes at commit time are
 *  parsed there and arrive with markdown, so this only sees what that path
 *  left empty: bytes-less attachments (Gmail), and binaries the commit path
 *  found text-poor or could not parse (re-parsed once here to record why). */
export function isConvertCandidate(doc: Document): boolean {
  if (doc.archivedAt) return false;
  if (doc.type !== 'attachment' && doc.type !== 'file') return false;
  const meta = doc.metadata as ConvertMeta;
  if (meta.extraction != null) return false;
  const kind = convertibleKind(str(meta.mime), fileName(doc));
  if (kind === null) return false;
  if (meta.conversion != null) {
    // too-large is cap-relative: re-admit when the current cap admits it.
    const { status: st, bytes: fetched } = meta.conversion as {
      status?: unknown;
      bytes?: unknown;
    };
    const declared = num(meta.sizeBytes) ?? num(meta.size);
    // The observed size wins: a body larger than its declared size stays
    // too-large until the cap itself grows past it.
    return (
      st === 'too-large' &&
      declared !== undefined &&
      Math.max(declared, num(fetched) ?? 0) <= convertCapFor(kind)
    );
  }
  if ((doc.markdown ?? '').trim().length >= HAS_TEXT_CHARS) return false;
  return true;
}

/**
 * The parse stage of the extraction chain for documents that arrive without
 * bytes: fetch through the document's own source, run the SAME parser the
 * commit path uses, and record the outcome in `metadata.conversion`. A PDF
 * the parser gives up on is then picked up by the vision worker (OCR), which
 * waits for that marker. No inference is involved, so the re-drive is not
 * held to the processing window.
 */
export function createConvertWorker(
  deps: {
    now?: () => Date;
    /** Test seam only; defaults to the real parser. */
    parse?: typeof realParse;
  } = {},
): Worker {
  const now = deps.now ?? (() => new Date());
  const parse = deps.parse ?? realParse;
  return {
    name: 'convert',
    // bump = one full feed replay: re-admits too-large rows (large-file),
    // .msg attachments, garbled PDFs. The ONLY convert bump this release.
    version: 2,
    schedule: { every: '5m' }, // re-drive for docs deferred while their source was registering
    matches: (change: Change) =>
      change.kind === 'document' && isConvertCandidate(change.document),

    async work(change: Change, session: WorkerSession): Promise<WorkOutcome> {
      if (change.kind !== 'document') return 'skip';
      const doc = change.document;
      const meta = doc.metadata as ConvertMeta;
      const name = fileName(doc);

      const record = (
        status: ConversionStatus,
        extra: {
          markdown?: string;
          error?: string;
          truncated?: true;
          bytes?: number;
          quality?: 1;
        } = {},
      ): WorkOutcome => {
        const conversion: ConversionOutcome = {
          status,
          at: now().toISOString(),
          ...(extra.error ? { error: extra.error.slice(0, 500) } : {}),
          ...(extra.truncated ? { truncated: true as const } : {}),
          ...(extra.bytes !== undefined ? { bytes: extra.bytes } : {}),
          ...(extra.quality ? { quality: extra.quality } : {}),
        };
        session.enrich({
          documentId: doc.id,
          ...(extra.markdown !== undefined ? { markdown: extra.markdown } : {}),
          metadata: { conversion },
        });
        return 'done';
      };

      const kind = convertibleKind(str(meta.mime), name);
      if (kind === null) return 'skip';
      const capBytes = convertCapFor(kind);
      const declared = num(meta.sizeBytes) ?? num(meta.size);
      if (declared !== undefined && declared > capBytes)
        return record('too-large');

      // A fetch that fails right now (source still registering, offline,
      // re-auth needed) throws FetchDeferredError; the engine parks it for
      // the re-drive. Only a definite "no bytes" (null) is recorded here.
      // Before the fetch: the memory probe's peak covers fetch, transport
      // copies and parse together.
      const rssBefore = process.memoryUsage().rss;
      const bytes = await session.fetchBytes(doc);
      if (!bytes) return record('unavailable');
      if (bytes.length > capBytes)
        return record('too-large', { bytes: bytes.length });
      // Crash fence AFTER the bytes arrive, BEFORE the parse: only a parse
      // can kill main; counting deferred fetches would fail docs on an
      // outage. Keyed on max(declared, actual): size makes a parse risky.
      const large =
        Math.max(declared ?? 0, bytes.length) > MAX_LOCAL_BINARY_BYTES;
      // Mail (.msg, .eml…) is fenced at any size: it arrives from anyone as
      // an attachment, and a hostile one need not be large to kill the
      // in-process parser.
      if ((large || kind === 'email') && (await session.bump('parse')) > 2)
        return record('failed', {
          error: 'parser crashed twice on this document',
        });

      let res: { markdown: string | null; ocrPages?: number[] };
      try {
        res = await parse(bytes, str(meta.mime) ?? '', name);
      } catch (err) {
        session.log(
          'warn',
          `parse failed for ${name ?? doc.id}: ${String(err)}`,
        );
        return record('failed', { error: String(err) });
      }
      if (large) logPeak(session, name ?? doc.id, bytes.length, rssBefore); // the memory probe
      if (res.markdown === null || res.markdown.trim().length === 0)
        return record('text-poor');
      const capped = capMarkdown(res.markdown);
      if (res.ocrPages) {
        // Deterministic marker, no `at` (the commit path writes the same
        // one; contentHash covers metadata). All text is kept: OCR replaces
        // a listed page's text only when it reads something.
        session.enrich({
          documentId: doc.id,
          markdown: capped.markdown,
          metadata: { conversion: needsOcrMarker(res.ocrPages) },
        });
        return 'done';
      }
      return record('ok', {
        markdown: capped.markdown,
        ...(capped.truncated ? { truncated: true as const } : {}),
        // Assessed by the current text-quality rules (garbled-PDF §5).
        ...(kind === 'pdf' ? { quality: 1 as const } : {}),
      });
    },
  };
}
