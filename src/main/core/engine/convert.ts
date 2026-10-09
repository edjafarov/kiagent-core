import type { DocumentInput } from '@shared/contracts';

import { isAbortError } from '../abort';
import {
  capMarkdown,
  convertibleKind,
  needsOcrMarker,
} from '../converter/parsers';
import {
  ConverterCrashedError,
  createInlineConverter,
  type Converter,
} from '../converter/converter';

import type { LogSink } from './engine';
import { QUALITY_VERSION } from './text-quality';

export {
  MAX_MARKDOWN_CHARS,
  capMarkdown,
  convertibleKind,
  needsOcrMarker,
  parse,
  parseDetailed,
  parsePdfPages,
  type ConvertibleKind,
} from '../converter/parsers';

/**
 * Commit-path stage 1: deterministic binary → markdown. Parsers only — no
 * inference. Text-poor results (scans, images) keep `markdown: null` so a
 * vision worker picks them up later via the 'defer' two-pass pattern.
 *
 * Runs in-process for now; the crash-isolated worker pool rides the
 * converter/worker.ts entry when it lands (see LEFTOVERS).
 */
export function createConverter(
  logs: LogSink,
  converter: Pick<Converter, 'parseDetailed'> = createInlineConverter(),
): (input: DocumentInput, signal?: AbortSignal) => Promise<DocumentInput> {
  return async (input, signal) => {
    if (!input.binary || input.markdown !== null) return stripBinary(input);
    const { bytes, mime, filename } = input.binary;
    try {
      const { markdown: md, ocrPages } = await converter.parseDetailed(
        bytes,
        mime,
        filename,
        signal,
      );
      if (md !== null) {
        const base = {
          ...stripBinary(input),
          markdown: capMarkdown(md).markdown,
        };
        // Deterministic, no timestamp: contentHash covers metadata (garbled
        // spec §3), so the same bytes always commit the same row. A clean
        // PDF is stamped assessed too, so the convert worker never re-reads
        // its text to decide whether it is garbled.
        if (ocrPages)
          return {
            ...base,
            metadata: {
              ...input.metadata,
              conversion: needsOcrMarker(ocrPages),
            },
          };
        if (convertibleKind(mime, filename) === 'pdf')
          return {
            ...base,
            metadata: {
              ...input.metadata,
              conversion: { status: 'ok', quality: QUALITY_VERSION },
            },
          };
        return base;
      }
    } catch (err) {
      // The pull loop is stopping: nothing of this batch may commit.
      if (isAbortError(err)) throw err;
      if (err instanceof ConverterCrashedError) {
        logs.log(
          'converter',
          'warn',
          `converter crashed on ${filename ?? mime}`,
        );
        // Deterministic marker (no `at`): the convert worker never re-admits
        // a doc carrying `conversion`, and a PDF still goes to OCR
        // (pdfReadyForOcr: 'failed').
        return {
          ...stripBinary(input),
          metadata: {
            ...input.metadata,
            conversion: { status: 'failed', reason: 'crash' },
          },
        };
      }
      // Timeout / unavailable / an ordinary parser throw: no marker — the
      // convert worker re-tries it later through the source's fetchBytes.
      logs.log(
        'converter',
        'warn',
        `parse failed for ${filename ?? mime}: ${String(err)}`,
      );
    }
    // Unparseable or text-poor: stays markdown-null for the vision pass.
    return stripBinary(input);
  };
}

function stripBinary(input: DocumentInput): DocumentInput {
  const { binary: _binary, ...rest } = input;
  return rest;
}
