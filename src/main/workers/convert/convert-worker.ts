import type {
  Change,
  Document,
  Worker,
  WorkerSession,
  WorkOutcome,
} from '@shared/contracts';
import { MAX_LOCAL_BINARY_BYTES } from '@shared/file-indexability';

import { convertibleKind, parse } from '@main/core/engine/convert';
import { SourceNotReadyError } from '@main/core/engine/source-not-ready';

import type { ConversionOutcome, ConversionStatus } from './outcome';

/** Largest file the worker will fetch and parse — the same cap local files
 *  get on the commit path. Parsing runs in-process, like the commit path. */
export const MAX_CONVERT_BYTES = MAX_LOCAL_BINARY_BYTES;

/** Mirrors the vision classifier's "has real text already" bar. */
const HAS_TEXT_CHARS = 16;

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
  if (meta.conversion != null || meta.extraction != null) return false;
  if ((doc.markdown ?? '').trim().length >= HAS_TEXT_CHARS) return false;
  return convertibleKind(str(meta.mime), fileName(doc)) !== null;
}

/**
 * The parse stage of the extraction chain for documents that arrive without
 * bytes: fetch through the document's own source, run the SAME parser the
 * commit path uses, and record the outcome in `metadata.conversion`. A PDF
 * the parser gives up on is then picked up by the vision worker (OCR), which
 * waits for that marker. No inference is involved, so the re-drive is not
 * held to the processing window.
 */
export function createConvertWorker(deps: { now?: () => Date } = {}): Worker {
  const now = deps.now ?? (() => new Date());
  return {
    name: 'convert',
    version: 1,
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
        extra: { markdown?: string; error?: string } = {},
      ): WorkOutcome => {
        const conversion: ConversionOutcome = {
          status,
          at: now().toISOString(),
          ...(extra.error ? { error: extra.error.slice(0, 500) } : {}),
        };
        session.enrich({
          documentId: doc.id,
          ...(extra.markdown !== undefined ? { markdown: extra.markdown } : {}),
          metadata: { conversion },
        });
        return 'done';
      };

      const declared = num(meta.sizeBytes) ?? num(meta.size);
      if (declared !== undefined && declared > MAX_CONVERT_BYTES)
        return record('too-large');

      let bytes: Uint8Array | null;
      try {
        bytes = await session.fetchBytes(doc);
      } catch (err) {
        if (err instanceof SourceNotReadyError) return 'defer';
        throw err; // auth/network: the engine's bounded retry
      }
      if (!bytes) return record('unavailable');
      if (bytes.length > MAX_CONVERT_BYTES) return record('too-large');

      let markdown: string | null;
      try {
        markdown = await parse(bytes, str(meta.mime) ?? '', name);
      } catch (err) {
        session.log(
          'warn',
          `parse failed for ${name ?? doc.id}: ${String(err)}`,
        );
        return record('failed', { error: String(err) });
      }
      if (markdown === null || markdown.trim().length === 0)
        return record('text-poor');
      return record('ok', { markdown });
    },
  };
}
