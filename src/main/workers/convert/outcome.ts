/**
 * `metadata.conversion` — the convert worker's outcome marker, written only
 * by that worker (via a metadata-only enrich). Kept free of engine imports so
 * the vision classifier can read it without pulling the worker in.
 *
 * - `ok`          parsed; the markdown was written.
 * - `text-poor`   parsed, but too little text (a scanned PDF).
 * - `failed`      the parser threw; `error` holds the message.
 * - `too-large`   over the parse cap, never fetched.
 * - `unavailable` the source answered "no bytes" (e.g. deleted upstream).
 */
export type ConversionStatus =
  | 'ok'
  | 'text-poor'
  | 'failed'
  | 'too-large'
  | 'unavailable';

export interface ConversionOutcome {
  status: ConversionStatus;
  at: string;
  error?: string;
}

/** Outcomes after which a PDF is handed to OCR. `unavailable` is absent on
 *  purpose: vision fetches through the same source and would get the same
 *  null. */
const PDF_OCR_AFTER: ReadonlySet<string> = new Set([
  'text-poor',
  'failed',
  'too-large',
]);

export function pdfReadyForOcr(conversion: unknown): boolean {
  const status =
    conversion && typeof conversion === 'object'
      ? (conversion as { status?: unknown }).status
      : undefined;
  return typeof status === 'string' && PDF_OCR_AFTER.has(status);
}
