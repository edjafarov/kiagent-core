/**
 * `metadata.conversion` — the convert worker's outcome marker, written only
 * by that worker (via a metadata-only enrich). Kept free of engine imports so
 * the vision classifier can read it without pulling the worker in.
 *
 * - `ok`          parsed; the markdown was written.
 * - `text-poor`   parsed, but too little text (a scanned PDF).
 * - `failed`      the parser threw; `error` holds the message.
 * - `too-large`   over the per-kind cap (convertCapFor). Cap-relative: the
 *                 convert worker re-admits it when the cap rises. Never OCR'd.
 * - `unavailable` the source answered "no bytes" (e.g. deleted upstream).
 */
/** A doc with at least this much markdown already has real text: neither
 *  the convert worker nor OCR touches it. */
export const HAS_TEXT_CHARS = 16;

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
  /** The markdown was cut at MAX_MARKDOWN_CHARS. */
  truncated?: true;
  /** too-large only: the size actually fetched, when it exceeded the cap
   *  although the declared size did not. */
  bytes?: number;
}

/** Outcomes after which a PDF is handed to OCR. `unavailable` is absent on
 *  purpose: vision fetches through the same source and would get the same
 *  null. */
export const PDF_OCR_AFTER_STATUSES = [
  'text-poor',
  'failed',
] as const satisfies readonly ConversionStatus[];
const PDF_OCR_AFTER: ReadonlySet<string> = new Set(PDF_OCR_AFTER_STATUSES);

export function pdfReadyForOcr(conversion: unknown): boolean {
  const status =
    conversion && typeof conversion === 'object'
      ? (conversion as { status?: unknown }).status
      : undefined;
  return typeof status === 'string' && PDF_OCR_AFTER.has(status);
}
