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
  xls: 'application/vnd.ms-excel',
  // `mime` resolves .eml to message/rfc822 and .mbox to application/mbox on
  // its own; only Apple Mail's .emlx misses. It is RFC 5322 with a byte-count
  // first line and a plist trailer, so it routes to the same parser.
  emlx: 'message/rfc822',
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
  // Legacy Excel. The converter has always handled `ext === 'xls'`; only this
  // set kept the bytes from ever reaching it.
  'application/vnd.ms-excel',
  'text/csv',
  // Email. Deliberately NOT plain text: an .eml body is quoted-printable or
  // base64 and its attachments are base64 blobs, so a raw decode indexes the
  // encoding rather than the message. The converter runs it through
  // mailparser instead.
  'message/rfc822',
  // A concatenation of RFC 5322 messages; same parser, split first.
  'application/mbox',
]);

/**
 * Extensions that ARE plain text but whose mime says otherwise, or which have
 * no mime at all. Extension wins over the lookup for these.
 *
 * The lookup cannot be trusted alone here: `mime` maps .json to
 * application/json, .yaml to application/yaml, and — the trap worth naming —
 * .ts to `video/mp2t` (MPEG transport stream), which would send TypeScript
 * files to the audio transcriber. Nothing in this set needs a parser; the
 * source decodes it as UTF-8 and the engine indexes it directly.
 *
 * Notably ABSENT and deliberately so: csv/html (the converter renders them,
 * see BINARY_PARSEABLE_MIMES) and .env/.pem-style credential files (see
 * ingestible.ts's deny rule, which runs first).
 */
export const TEXT_EXTS = new Set([
  // notes and markup
  'text',
  'rst',
  'org',
  'adoc',
  'asciidoc',
  'tex',
  'bib',
  // structured data and config
  'json',
  'jsonl',
  'ndjson',
  'yaml',
  'yml',
  'toml',
  'ini',
  'cfg',
  'conf',
  'xml',
  'tsv',
  'sql',
  'log',
  'properties',
  // transcripts, calendars, contacts — plain text by spec
  'srt',
  'vtt',
  'ics',
  'vcf',
  // scripts and source people keep alongside documents
  'sh',
  'bash',
  'zsh',
  'ps1',
  'py',
  'rb',
  'pl',
  'lua',
  'r',
  'js',
  'mjs',
  'cjs',
  'jsx',
  'ts',
  'tsx',
  'css',
  'scss',
  'go',
  'rs',
  'java',
  'kt',
  'swift',
  'c',
  'h',
  'cpp',
  'hpp',
  'cs',
  'php',
]);

/**
 * Bucket for a real path — the form every caller in this source actually has.
 * Prefer this over `classifyMime(resolveMime(p))`: it consults TEXT_EXTS
 * first, which the mime lookup alone gets wrong (see above).
 */
export function classifyPath(absPath: string): FileBucket {
  const ext = path.extname(absPath).slice(1).toLowerCase();
  if (TEXT_EXTS.has(ext)) return 'text';
  return classifyMime(resolveMime(absPath));
}

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
