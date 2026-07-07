import type { Document } from '@shared/contracts';

const VISUAL_EXT_RE = /\.(pdf|png|jpe?g|gif|webp|heic|heif|tiff?|bmp)$/i;
const TINY_IMAGE_BYTES = 8 * 1024;
export const OCR_SUFFICIENT_CHARS = 200;
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_PDF_BYTES = 50 * 1024 * 1024;
export const MAX_PAGES = 20;

interface VisualMeta {
  mime?: string;
  filename?: string;
  sizeBytes?: number;
  extraction?: unknown;
}

export function isPdfDoc(doc: Document): boolean {
  const meta = doc.metadata as VisualMeta;
  const name = meta.filename ?? doc.title ?? '';
  return meta.mime === 'application/pdf' || /\.pdf$/i.test(name);
}

// Formats llama.cpp's bundled stb_image can decode for the VLM `see` pass.
// HEIC/WebP/TIFF are decodable by apple-vision OCR (pass 1) but NOT by the
// VLM — handing them to `see` fails on every attempt.
const VLM_DECODABLE_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/bmp',
]);
const VLM_UNDECODABLE_EXT_RE = /\.(webp|heic|heif|tiff?)$/i;

/** Can the VLM (`see`) decode this image? True for PNG/JPEG/GIF/BMP. Decided
 *  by mime when present (an `image/*` mime outside the decodable set — HEIC,
 *  WebP, TIFF — is undecodable), else by filename extension. Unknown formats
 *  default to TRUE so a possibly-fine image still gets its pass-2 attempt;
 *  only formats we can positively identify as undecodable are excluded, which
 *  keeps text-poor HEIC/WebP/TIFF from re-driving pass 2 forever. */
export function isVlmDecodable(doc: Document): boolean {
  const meta = doc.metadata as VisualMeta;
  const { mime } = meta;
  if (mime && mime.startsWith('image/')) return VLM_DECODABLE_MIME.has(mime);
  const name = meta.filename ?? doc.title ?? '';
  return !VLM_UNDECODABLE_EXT_RE.test(name);
}

export function classifyDocument(doc: Document): 'candidate' | 'skip' {
  if (doc.archivedAt) return 'skip';
  if (doc.type !== 'attachment' && doc.type !== 'file') return 'skip';
  const meta = doc.metadata as VisualMeta;
  if (meta.extraction != null) return 'skip'; // already enriched
  const name = meta.filename ?? doc.title ?? '';
  const pdf = isPdfDoc(doc);
  const image =
    (meta.mime ?? '').startsWith('image/') ||
    (!pdf && VISUAL_EXT_RE.test(name) && !/\.pdf$/i.test(name));
  if (!pdf && !image) return 'skip';
  if (image && (meta.sizeBytes ?? Number.MAX_SAFE_INTEGER) < TINY_IMAGE_BYTES)
    return 'skip';
  if ((doc.markdown ?? '').trim().length >= 16) return 'skip'; // has real text already
  return 'candidate';
}
