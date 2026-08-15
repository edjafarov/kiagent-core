import type { Document } from '@shared/contracts';

// Unambiguous audio containers (unchanged list). `.webm`/`.mkv` are handled
// by the ordered steps below, `weba` stays here (audio-only by convention).
const AUDIO_EXT_RE =
  /\.(mp3|m4a|m4b|aac|wav|wave|aiff?|caf|flac|ogg|oga|opus|weba|amr|wma|3gp)$/i;
// Video containers afconvert can demux when they carry an audio track
// (verified: afconvert -f WAVE -d LEI16@16000 -c 1 handles mp4/mov — spec §6).
const VIDEO_EXT_RE = /\.(mp4|m4v|mov)$/i;
// Containers we can't demux anywhere: CoreAudio has no Matroska demuxer
// (afconvert fails with `typ?`), and non-macOS hosts have no transcoder at
// all. Supporting these means bundling a demuxer — deliberate exclusion.
const DENY_EXT_RE = /\.(mkv|webm)$/i;
const DENY_MIMES = new Set(['video/webm', 'video/x-matroska']);

/** Max SOURCE bytes fetched into main-process heap for one pass, checked at
 *  classify time against the doc's size metadata (and re-checked post-fetch
 *  as a backstop for docs whose metadata carries no size). 200 MiB: whisper
 *  chunks long audio natively, so the cap exists to bound the transient
 *  fetch allocation, not the recording length. Raising it further needs the
 *  streaming fetch-to-temp-file follow-up (fetchBytes returns a Uint8Array
 *  by contract). Replaces the old 25 MiB AUDIO_MAX_BYTES. */
export const MAX_SOURCE_BYTES = 200 * 1024 * 1024;

interface TranscribableMeta {
  mime?: string;
  filename?: string;
  ext?: string;
  extraction?: unknown;
  sizeBytes?: number;
  size?: number;
}

/** Extensions are ALLOWLISTED, never sanitized: this value is interpolated
 *  into a temp-file name by the transcoder, and `metadata` is
 *  `Record<string, unknown>` filled by third-party marketplace connectors — an
 *  ext of `../../../../Users/<u>/target` would escape tmpdir into an
 *  arbitrary-file write-and-delete. Same charset the filename fallback below
 *  has always enforced. */
const SAFE_EXT_RE = /^[a-z0-9]{1,8}$/;

/** Best-effort source extension (lower-case, no leading dot) from the doc's
 *  metadata/filename/title — local-folder files carry `metadata.ext` but no
 *  mime, so the transcoder needs this to hint the decoder. Anything outside
 *  the allowlist yields '' (the transcoder falls back to its mime map). */
export function audioExt(doc: Document): string {
  const meta = doc.metadata as TranscribableMeta;
  // The typed view above is a hope, not a guarantee: metadata is
  // connector-supplied JSON, and a throw out of `matches()` stops the
  // worker's feed loop permanently. Non-string values classify as absent.
  if (typeof meta.ext === 'string' && meta.ext) {
    const ext = meta.ext.toLowerCase().replace(/^\./, '');
    return SAFE_EXT_RE.test(ext) ? ext : '';
  }
  const name = meta.filename ?? doc.title ?? '';
  const m = /\.([a-z0-9]+)$/i.exec(name);
  return m ? m[1].toLowerCase() : '';
}

/** Does this document carry audio we should try to transcribe (including the
 *  audio track of a video)? The matching ORDER is load-bearing (spec §6):
 *  a blanket extension-denylist-first would reject an audio/webm attachment
 *  with a .webm filename, which the pre-video classifier accepted and must
 *  keep accepting; a bare video/* allow without step 1 would admit
 *  video/webm and silently defeat the mkv/webm exclusion. */
export function isTranscribableDoc(doc: Document): boolean {
  const meta = doc.metadata as TranscribableMeta;
  // Normalize ONCE, before all four steps: a `Content-Type`-style mime can
  // legally carry parameters (`video/webm;codecs=vp9`), and steps 2/4 use
  // `startsWith` (parameter-tolerant) while step 1's `Set.has` is an exact
  // match — without stripping the parameter here, a parameterized deny-mime
  // would fail step 1, fail step 2, and fall through to step 4's `video/*`
  // allow, silently defeating the exclusion.
  const mime =
    typeof meta.mime === 'string'
      ? meta.mime.toLowerCase().split(';')[0].trim()
      : '';
  const name = meta.filename ?? doc.title ?? '';
  const dotExt = `.${audioExt(doc)}`;

  // 1. deny undemuxable video containers, even filename-less
  if (DENY_MIMES.has(mime)) return false;
  // 2. allow any audio/* mime (preserves audio-only .webm acceptance)
  if (mime.startsWith('audio/')) return true;
  // 3. deny .mkv/.webm extensions (no-mime local-folder files, and
  //    video-mime duplicates that also carry a filename)
  if (DENY_EXT_RE.test(name) || DENY_EXT_RE.test(dotExt)) return false;
  // 4. allow remaining video/* mimes and the extension sets
  if (mime.startsWith('video/')) return true;
  return (
    AUDIO_EXT_RE.test(name) ||
    AUDIO_EXT_RE.test(dotExt) ||
    VIDEO_EXT_RE.test(name) ||
    VIDEO_EXT_RE.test(dotExt)
  );
}

/**
 * The audio worker's candidate gate — the audio analog of the vision
 * classifier. Deliberately SEPARATE from `classifyDocument` (vision): if the
 * vision worker matched audio/video it would OCR/rasterize it to garbage and
 * stamp `metadata.extraction`, permanently blocking transcription.
 * Re-entrancy is covered by that same `extraction` marker: once the audio
 * worker enriches a doc, the re-emitted change has `metadata.extraction` set
 * and skips here.
 */
export function classifyTranscribable(doc: Document): 'candidate' | 'skip' {
  if (doc.archivedAt) return 'skip';
  if (doc.type !== 'attachment' && doc.type !== 'file') return 'skip';
  const meta = doc.metadata as TranscribableMeta;
  if (meta.extraction != null) return 'skip'; // already extracted/transcribed
  // Size gate BEFORE the fetch: without it, widening to video materialises a
  // 2 GB screen recording in heap just to reject it — the OOM class fixed in
  // core v0.73.1 (spec §6).
  const size = meta.sizeBytes ?? meta.size;
  if (typeof size === 'number' && size > MAX_SOURCE_BYTES) return 'skip';
  if (!isTranscribableDoc(doc)) return 'skip';
  return 'candidate';
}
