import path from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-require-imports -- mime@3's
// runtime API (`Mime.getType`) doesn't match @types/mime's bundled v1/v2
// declarations (`mime.lookup`). kiagent-ref hits the exact same mismatch and
// casts the `require` result the same way (kiagent-ref
// src/main/connectors/local-folder/scanner.ts:7-10).
const mimeLib = require('mime') as {
  getType: (filename: string) => string | null;
};

// Gmail-style fallback table for when the `mime` lookup misses or returns the
// generic `application/octet-stream` — same rationale and near-identical list
// as kiagent-ref's converter (kiagent-ref src/main/converter/index.ts:149-158).
const EXT_MIME_FALLBACK: Record<string, string> = {
  txt: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  html: 'text/html',
  htm: 'text/html',
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv',
};

/** Resolve a file's mime type from its name/extension. Never throws. */
export function resolveMime(absPath: string): string {
  const detected = mimeLib.getType(absPath);
  const lower = detected?.toLowerCase();
  if (lower && lower !== 'application/octet-stream') return lower;
  const ext = path.extname(absPath).slice(1).toLowerCase();
  return EXT_MIME_FALLBACK[ext] ?? lower ?? 'application/octet-stream';
}

export type FileBucket = 'text' | 'binary' | 'unsupported';

/** Plain text: the SOURCE decodes it directly into `DocumentInput.markdown`
 *  — no engine conversion needed. */
const PLAIN_TEXT_MIMES = new Set(['text/plain', 'text/markdown']);

/**
 * Parseable binary payloads: the source hands raw bytes through
 * `DocumentInput.binary` and leaves `markdown: null` — the ENGINE's converter
 * does the extraction (per contracts.ts's DocumentInput doc comment). This is
 * the exact mime set kiagent-ref's shared Converter supports, minus images
 * (kiagent-ref src/main/converter/index.ts:79-118, `SUPPORTED_MIME_TYPES`).
 */
const BINARY_PARSEABLE_MIMES = new Set([
  'text/html',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/csv',
]);

/** Anything outside these two sets (images, archives, executables, unknown
 *  binaries, application/octet-stream, …) is `'unsupported'` — indexed as a
 *  metadata-only document, matching kiagent-ref's behavior of always
 *  creating a doc even when extraction_status ends up 'unsupported'
 *  (kiagent-ref src/main/converter/index.ts:143). */
export function classifyMime(mt: string): FileBucket {
  if (PLAIN_TEXT_MIMES.has(mt)) return 'text';
  if (BINARY_PARSEABLE_MIMES.has(mt)) return 'binary';
  return 'unsupported';
}
