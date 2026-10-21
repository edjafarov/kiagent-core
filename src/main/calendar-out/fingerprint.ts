import { createHash } from 'crypto';

import type { EventPayload } from '../core/store/event-drafts';

/** Lower-case word tokens (letters in any script, digits), de-duplicated and
 *  sorted, so word order and punctuation never split two wordings apart. */
function titleTokens(t: string): string[] {
  const words = t.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return [...new Set(words)].sort();
}

export function normalizeTitle(t: string): string {
  return titleTokens(t).join(' ');
}

/** Token Jaccard: 1 = same words, 0 = nothing shared. */
export function titleSimilarity(a: string, b: string): number {
  const ta = new Set(titleTokens(a));
  const tb = new Set(titleTokens(b));
  if (ta.size === 0 && tb.size === 0) return 1;
  let shared = 0;
  ta.forEach((w) => {
    if (tb.has(w)) shared += 1;
  });
  return shared / (ta.size + tb.size - shared);
}

/** Dedupe key (spec §5.4): same account, same start minute (or date for an
 *  all-day event) and same normalized title. Different times never merge. */
export function fingerprintOf(
  accountId: string,
  p: Pick<EventPayload, 'title' | 'start' | 'allDay'>,
): string {
  const when = p.allDay
    ? p.start.slice(0, 10)
    : new Date(p.start).toISOString().slice(0, 16);
  return createHash('sha256')
    .update(`${accountId}|${when}|${normalizeTitle(p.title)}`)
    .digest('hex');
}
