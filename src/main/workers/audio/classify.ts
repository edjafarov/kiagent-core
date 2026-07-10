import type { Document } from '@shared/contracts';

// Unambiguous audio containers. `.webm`/`.mkv` are intentionally excluded —
// they are usually VIDEO; an audio-only `.webm` still matches via its
// `audio/*` mime below.
const AUDIO_EXT_RE =
  /\.(mp3|m4a|m4b|aac|wav|wave|aiff?|caf|flac|ogg|oga|opus|weba|amr|wma|3gp)$/i;

/** Max bytes we hand to a single transcription pass. Audio is dense and the
 *  server context is bounded, so an over-long recording is skipped rather than
 *  truncated mid-word (chunking long audio is a follow-up). */
export const AUDIO_MAX_BYTES = 25 * 1024 * 1024;

interface AudioMeta {
  mime?: string;
  filename?: string;
  ext?: string;
  extraction?: unknown;
}

/** Best-effort source extension (lower-case, no leading dot) from the doc's
 *  metadata/filename/title — local-folder files carry `metadata.ext` but no
 *  mime, so the transcoder needs this to hint the decoder. */
export function audioExt(doc: Document): string {
  const meta = doc.metadata as AudioMeta;
  if (meta.ext) return meta.ext.toLowerCase().replace(/^\./, '');
  const name = meta.filename ?? doc.title ?? '';
  const m = /\.([a-z0-9]+)$/i.exec(name);
  return m ? m[1].toLowerCase() : '';
}

/** Does this document carry audio we should try to transcribe? Keyed on the
 *  `audio/*` mime when present (gmail/extension attachments), else on the
 *  filename/extension (local-folder files, which have `ext` but no mime). */
export function isAudioDoc(doc: Document): boolean {
  const meta = doc.metadata as AudioMeta;
  if ((meta.mime ?? '').startsWith('audio/')) return true;
  const name = meta.filename ?? doc.title ?? '';
  return AUDIO_EXT_RE.test(name) || AUDIO_EXT_RE.test(`.${audioExt(doc)}`);
}

/**
 * The audio worker's candidate gate — the audio analog of the vision
 * classifier. Deliberately SEPARATE from `classifyDocument` (vision): if the
 * vision worker matched audio it would OCR it to garbage and stamp
 * `metadata.extraction`, permanently blocking transcription. Re-entrancy is
 * covered by that same `extraction` marker: once the audio worker enriches a
 * doc, the re-emitted change has `metadata.extraction` set and skips here.
 */
export function classifyAudio(doc: Document): 'candidate' | 'skip' {
  if (doc.archivedAt) return 'skip';
  if (doc.type !== 'attachment' && doc.type !== 'file') return 'skip';
  const meta = doc.metadata as AudioMeta;
  if (meta.extraction != null) return 'skip'; // already extracted/transcribed
  if (!isAudioDoc(doc)) return 'skip';
  return 'candidate';
}
