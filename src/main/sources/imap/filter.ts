/**
 * Automated-sender / bulk-mail filter — ported from
 * kiagent-ref/src/main/connectors/email-shared/filter.ts. Legacy applied this
 * to the first message of a *thread*; this port applies it per message
 * (there are no threads here), so a bounce or a newsletter issue is simply
 * skipped by toDocument() rather than skipping an entire thread.
 */
export interface FilterResult {
  matched: boolean;
  reason?: string;
}

const SYSTEM_LOCALPARTS = [
  /^mailer-daemon$/i,
  /^postmaster$/i,
  /^no-?reply$/i,
  /^do[-_ ]?not[-_ ]?reply$/i,
  /^bounce[-+a-z0-9]*$/i,
];

export function isAutomatedMessage(
  headers: Record<string, string>,
  fromHeader: string,
): FilterResult {
  const h = lowerKeys(headers);
  const autoSub = h['auto-submitted'];
  if (autoSub && autoSub.toLowerCase() !== 'no') {
    return { matched: true, reason: `Auto-Submitted: ${autoSub}` };
  }

  const prec = (h.precedence ?? '').toLowerCase();
  if (['bulk', 'list', 'junk', 'auto_reply'].includes(prec)) {
    return { matched: true, reason: `Precedence: ${prec}` };
  }

  for (const k of ['list-id', 'list-unsubscribe', 'list-post']) {
    if (h[k]) return { matched: true, reason: `${k}: ${h[k]}` };
  }

  const suppress = (h['x-auto-response-suppress'] ?? '').toLowerCase();
  if (['all', 'autoreply', 'oof', 'dr'].some((t) => suppress.includes(t))) {
    return { matched: true, reason: `X-Auto-Response-Suppress: ${suppress}` };
  }
  if (h['x-autoreply'] || h['x-autorespond']) {
    return { matched: true, reason: 'X-Autoreply/X-Autorespond present' };
  }

  const rp = (h['return-path'] ?? '').trim();
  if ((rp === '<>' || rp === '') && h['return-path'] !== undefined) {
    return { matched: true, reason: 'empty Return-Path' };
  }

  const local = extractLocalPart(fromHeader);
  if (local && SYSTEM_LOCALPARTS.some((rx) => rx.test(local))) {
    return { matched: true, reason: `system-sender: ${local}` };
  }

  const ct = (h['content-type'] ?? '').toLowerCase();
  if (
    ct.startsWith('multipart/report') &&
    ct.includes('report-type=') &&
    ct.includes('delivery-status')
  ) {
    return { matched: true, reason: 'DSN multipart/report' };
  }

  return { matched: false };
}

function lowerKeys(h: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = v;
  return out;
}

function extractLocalPart(addr: string): string | null {
  const m = addr.match(/<([^>]+)>/);
  const email = m ? m[1] : addr.trim();
  const at = email.indexOf('@');
  return at < 0 ? null : email.slice(0, at).toLowerCase();
}
