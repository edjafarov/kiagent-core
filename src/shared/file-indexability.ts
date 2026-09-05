/**
 * The canonical "can this file be indexed?" policy.
 *
 * kiagent-core used to decide this in four unrelated places: the
 * local-folder ingestion allowlist, the vision worker's visual-extension
 * list, the audio worker's transcribable-extension list, and each cloud
 * connector's `isConvertibleMime`. This module is the single source of
 * truth those all derive from — `workers/vision/classify.ts`,
 * `workers/audio/classify.ts`, `local-folder/mime.ts` and
 * `local-folder/ingestible.ts` import from here and re-export under their
 * existing names, and the connector SDK ships this file verbatim so the two
 * independently released cloud connectors cannot drift from it either.
 *
 * This file is copied verbatim into the SDK by
 * `sdk/connector-sdk/scripts/generate.mjs` and that copy must compile with
 * NO imports (see `contracts.ts` / `source-errors.ts`) — so nothing here may
 * import from `@main/*`. The data lives here; the workers derive from it,
 * never the other way around.
 */

export type FileSourceProfile = 'local-folder' | 'cloud-drive';
export type FilePipeline = 'inline-text' | 'converter' | 'vision' | 'audio';
export type FileIgnoreReason =
  | 'sensitive'
  | 'no-extension'
  | 'archive'
  | 'cloud-media'
  | 'unsupported'
  | 'too-large';
export type FileIndexDecision =
  | { kind: 'index'; pipeline: FilePipeline }
  | { kind: 'ignore'; reason: FileIgnoreReason };
export interface FileIndexCandidate {
  profile: FileSourceProfile;
  filename: string;
  mime?: string | null;
  sizeBytes?: number | null;
  path?: string | null;
}

export const MAX_LOCAL_TEXT_BYTES = 2 * 1024 * 1024; // scanner.ts MAX_INLINE_TEXT_BYTES
export const MAX_LOCAL_BINARY_BYTES = 20 * 1024 * 1024; // scanner.ts MAX_BINARY_READ_BYTES
export const MAX_LOCAL_IMAGE_BYTES = 20 * 1024 * 1024; // vision MAX_IMAGE_BYTES
export const MAX_LOCAL_PDF_BYTES = 50 * 1024 * 1024; // vision MAX_PDF_BYTES
export const MAX_LOCAL_AUDIO_BYTES = 200 * 1024 * 1024; // audio MAX_SOURCE_BYTES
export const MAX_CLOUD_BINARY_BYTES = 25 * 1024 * 1024; // connector MAX_BINARY_BYTES
export const MAX_CLOUD_IMAGE_BYTES = 20 * 1024 * 1024; // vision would skip anything larger

// Verbatim from local-folder/ingestible.ts:22-23 and :31. `ingestible.ts`
// re-exports the first as INGESTIBLE_DENY_RE, the name its test imports.
export const SENSITIVE_BASENAME_RE =
  /^(\.env(\..+)?|\.npmrc|\.netrc|\.git-credentials|\.htpasswd|id_[a-z0-9]+|.*\.(pem|key|p12|pfx|jks|keystore|asc|gpg|crt|cer|der)|.*\.min\.(js|css)|.*\.map|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|composer\.lock)$/i;
export const NOINDEX_DIR_RE = /(^|\/)[^/]*\.noindex(\/|$)/i;

const ARCHIVE_EXTENSIONS = new Set([
  'zip',
  'tar',
  'tgz',
  'gz',
  'bz2',
  'xz',
  'zst',
  '7z',
  'rar',
  'cab',
  'iso',
  'dmg',
  'img',
  'vhd',
  'vhdx',
  'ova',
  'war',
  'jar',
  'apk',
  'ipa',
]);
const ARCHIVE_MIMES = new Set([
  'application/zip',
  'application/x-7z-compressed',
  'application/x-rar-compressed',
  'application/vnd.rar',
  'application/x-tar',
  'application/gzip',
  'application/x-gzip',
  'application/x-bzip2',
  'application/x-xz',
  'application/zstd',
  'application/x-iso9660-image',
  'application/vnd.android.package-archive',
  'application/java-archive',
]);

// Verbatim from audio/classify.ts's AUDIO_EXT_RE / VIDEO_EXT_RE / DENY_EXT_RE.
export const AUDIO_EXTENSIONS = new Set([
  'mp3',
  'm4a',
  'm4b',
  'aac',
  'wav',
  'wave',
  'aif',
  'aiff',
  'caf',
  'flac',
  'ogg',
  'oga',
  'opus',
  'weba',
  'amr',
  'wma',
  '3gp',
]);
export const LOCAL_VIDEO_EXTENSIONS = new Set(['mp4', 'm4v', 'mov']);
export const UNDEMUXABLE_EXTENSIONS = new Set(['mkv', 'webm']);

// Verbatim from vision/classify.ts's VISUAL_EXTS (which includes 'pdf').
export const VISUAL_EXTENSIONS = new Set([
  'pdf',
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'heic',
  'heif',
  'tif',
  'tiff',
  'bmp',
]);

// Verbatim from local-folder/mime.ts's TEXT_EXTS.
export const LOCAL_TEXT_EXTENSIONS = new Set([
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
  'geojson',
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

// Verbatim from local-folder/mime.ts's BINARY_PARSEABLE_MIMES: what the local
// source hands to the engine converter today. The cloud set is deliberately
// SMALLER — it mirrors each connector's isConvertibleMime, so this change adds
// nothing to what Drive/Graph will download.
export const LOCAL_CONVERTER_MIMES = new Set([
  'text/html',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'text/csv',
  'message/rfc822',
  'application/mbox',
]);
const CLOUD_CONVERTER_MIMES = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);

const normalizedSize = (v: number | null | undefined): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
const extension = (name: string): string => {
  const base = name.toLowerCase().split(/[\\/]/).pop() ?? '';
  const i = base.lastIndexOf('.');
  return i <= 0 || i === base.length - 1 ? '' : base.slice(i + 1);
};
const over = (size: number | null, cap: number): boolean =>
  size !== null && size > cap;
const cap = (
  size: number | null,
  limit: number,
  pipeline: FilePipeline,
): FileIndexDecision =>
  over(size, limit)
    ? { kind: 'ignore', reason: 'too-large' }
    : { kind: 'index', pipeline };

export function decideFileIndexing(c: FileIndexCandidate): FileIndexDecision {
  const local = c.profile === 'local-folder';
  const name = typeof c.filename === 'string' ? c.filename : '';
  const base = name.split(/[\\/]/).pop() ?? '';
  const ext = extension(name);
  const mime =
    typeof c.mime === 'string'
      ? c.mime.toLowerCase().split(';', 1)[0].trim()
      : '';
  const size = normalizedSize(c.sizeBytes);
  const path = typeof c.path === 'string' ? c.path.split('\\').join('/') : '';

  // 1. Credential/noise basenames and macOS .noindex subtrees — local only,
  //    because a cloud provider has no such convention.
  if (
    local &&
    (NOINDEX_DIR_RE.test(path) || SENSITIVE_BASENAME_RE.test(base))
  ) {
    return { kind: 'ignore', reason: 'sensitive' };
  }
  // 2. Extensionless local files: sniffing content would defeat a gate whose
  //    whole point is being cheap at enumeration time.
  if (local && !ext) return { kind: 'ignore', reason: 'no-extension' };
  // 3. Archives, at every size, on both profiles. The extension test is the
  //    backstop for a generic or missing provider MIME.
  if (ARCHIVE_EXTENSIONS.has(ext) || ARCHIVE_MIMES.has(mime)) {
    return { kind: 'ignore', reason: 'archive' };
  }
  // 4. Cloud media, before any positive branch could rescue it.
  if (
    !local &&
    (mime.startsWith('audio/') ||
      mime.startsWith('video/') ||
      AUDIO_EXTENSIONS.has(ext) ||
      LOCAL_VIDEO_EXTENSIONS.has(ext) ||
      UNDEMUXABLE_EXTENSIONS.has(ext))
  ) {
    return { kind: 'ignore', reason: 'cloud-media' };
  }
  // 5. PDFs, before the generic image branch (VISUAL_EXTENSIONS holds 'pdf').
  //    Local PDFs have TWO budgets: over the source's read cap they are
  //    committed metadata-only and the vision worker pulls their bytes back
  //    through fetchBytes — the behavior that exists today. A cloud PDF gets
  //    one cap because the connector's own fetchBytes refuses anything larger,
  //    so the vision route is unreachable above it.
  if (mime === 'application/pdf' || ext === 'pdf') {
    if (!local) return cap(size, MAX_CLOUD_BINARY_BYTES, 'converter');
    if (!over(size, MAX_LOCAL_BINARY_BYTES)) {
      return { kind: 'index', pipeline: 'converter' };
    }
    return cap(size, MAX_LOCAL_PDF_BYTES, 'vision');
  }
  // 6. Images. Local matches isIngestible (VISUAL_EXTS membership); cloud
  //    matches each connector's isConvertibleMime (any image/*).
  const image = local
    ? VISUAL_EXTENSIONS.has(ext)
    : mime.startsWith('image/') || VISUAL_EXTENSIONS.has(ext);
  if (image) {
    return cap(
      size,
      local ? MAX_LOCAL_IMAGE_BYTES : MAX_CLOUD_IMAGE_BYTES,
      'vision',
    );
  }
  // 7. Local inline text. Extension wins here: mime@3 calls .ts video/mp2t,
  //    and testing video before this branch would send source code to ASR.
  if (
    local &&
    (LOCAL_TEXT_EXTENSIONS.has(ext) ||
      mime === 'text/plain' ||
      mime === 'text/markdown')
  ) {
    return cap(size, MAX_LOCAL_TEXT_BYTES, 'inline-text');
  }
  // 8. Local audio/video — EXACTLY isTranscribableExt: deny .mkv/.webm, then
  //    allow the two extension sets. An audio/* MIME still needs a known
  //    extension, because the local source has never ingested anything else.
  //    Looks like a bug but isn't: a local .webm is 'unsupported' even when
  //    its MIME says audio/webm, because isTranscribableExt denies the
  //    extension outright and the local source has therefore never ingested
  //    one.
  if (local) {
    if (UNDEMUXABLE_EXTENSIONS.has(ext)) {
      return { kind: 'ignore', reason: 'unsupported' };
    }
    if (AUDIO_EXTENSIONS.has(ext) || LOCAL_VIDEO_EXTENSIONS.has(ext)) {
      return cap(size, MAX_LOCAL_AUDIO_BYTES, 'audio');
    }
  }
  // 9. Converter. Cloud admits text/* plus the three Office/PDF MIMEs, which
  //    is isConvertibleMime minus images; local admits exactly the mimes
  //    BINARY_PARSEABLE_MIMES admits today. Neither set gains a member here.
  //    Also looks like a bug: a cloud .eml or .xls is 'unsupported' because
  //    neither connector's isConvertibleMime admits it today, and widening
  //    cloud coverage does not belong in a change advertised as strictly
  //    narrowing — local keeps converting both.
  const converter = local
    ? LOCAL_CONVERTER_MIMES.has(mime)
    : mime.startsWith('text/') || CLOUD_CONVERTER_MIMES.has(mime);
  if (converter) {
    return cap(
      size,
      local ? MAX_LOCAL_BINARY_BYTES : MAX_CLOUD_BINARY_BYTES,
      'converter',
    );
  }
  return { kind: 'ignore', reason: 'unsupported' };
}
