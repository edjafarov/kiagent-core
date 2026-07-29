/**
 * Shared chat-day helpers: normalize, merge, and render a day's worth of
 * messages from a connector's ingest path into the day-doc markdown body.
 * Every rendering rule (voice-note duration label, document label, quote
 * line) is a byte-for-byte contract with existing day docs, so this module
 * carries no per-platform knowledge — each connector keeps its own
 * `DOC_TYPE` string.
 */

/** A single chat message after normalization from a connector's ingest path. */
export interface NormalizedMessage {
  /** Stable id: the source platform's message id. */
  id: string;
  /** Epoch milliseconds. */
  tsMs: number;
  /** Display name of the sender, already resolved. null ⇒ system message. */
  sender: string | null;
  /** Plain text body (caption for media, '' for pure media/system). */
  text: string;
  /** Present when the message carries media. */
  media?: MediaDescriptor;
  /** Quoted/replied-to message, rendered inline. */
  quote?: { sender: string | null; snippet: string };
  /** True for platform system notices (membership changes, encryption notices, etc.). */
  system: boolean;
}

export type MediaKind = 'image' | 'video' | 'audio' | 'document' | 'sticker';

export interface MediaDescriptor {
  kind: MediaKind;
  /** Original filename if known (document messages). */
  filename?: string;
  /** Mime type if known. */
  mimeType?: string;
  /** Duration seconds for audio/video, for the placeholder label. */
  durationSec?: number;
}

/** Local-calendar day key 'YYYY-MM-DD' for an epoch-ms timestamp. */
export function dayKey(tsMs: number): string {
  const d = new Date(tsMs);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Union of existing + incoming messages, deduped by id (incoming wins on
 * conflict), ascending by `ts`. `compareIds` breaks ties when two messages
 * share a timestamp — default lexical (`localeCompare`); pass a numeric
 * comparator for platforms whose ids sort numerically (e.g. `'9' < '10'`).
 */
export function mergeMessages<M extends { id: string }>(
  existing: M[],
  incoming: M[],
  ts: (m: M) => number,
  compareIds: (a: string, b: string) => number = (a, b) => a.localeCompare(b),
): M[] {
  const byId = new Map<string, M>();
  for (const m of existing) byId.set(m.id, m);
  for (const m of incoming) byId.set(m.id, m); // incoming wins on conflict
  return [...byId.values()].sort(
    (a, b) => ts(a) - ts(b) || compareIds(a.id, b.id),
  );
}

function hhmm(tsMs: number): string {
  const d = new Date(tsMs);
  return `${String(d.getHours()).padStart(2, '0')}:${String(
    d.getMinutes(),
  ).padStart(2, '0')}`;
}

function mediaLabel(media: MediaDescriptor): string {
  if (media.kind === 'audio' && media.durationSec) {
    const mm = Math.floor(media.durationSec / 60);
    const ss = String(Math.floor(media.durationSec % 60)).padStart(2, '0');
    return `[voice note ${mm}:${ss}]`;
  }
  if (media.kind === 'document')
    return `[document: ${media.filename ?? 'file'}]`;
  return `[${media.kind}]`;
}

/**
 * Render the day's messages to markdown. Media renders as its label only —
 * navigation to the bytes is the `file` document's parent edge onto this day.
 */
export function renderDay(messages: NormalizedMessage[]): string {
  const lines: string[] = [];
  for (const m of messages) {
    if (m.system) {
      lines.push(`_${m.text}_`);
      continue;
    }
    const parts: string[] = [`${hhmm(m.tsMs)} ${m.sender ?? '?'}:`];
    if (m.quote) parts.push(`↳re ${m.quote.sender ?? '?'}: ${m.quote.snippet}`);
    if (m.media) parts.push(mediaLabel(m.media));
    if (m.text) parts.push(m.text);
    lines.push(parts.join(' '));
  }
  return lines.join('\n');
}

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/** '<chatName> — Mon D, YYYY' for a 'YYYY-MM-DD' day key. */
export function dayTitle(chatName: string, key: string): string {
  const [y, m, d] = key.split('-').map(Number);
  return `${chatName} — ${MONTHS[m - 1]} ${d}, ${y}`;
}
