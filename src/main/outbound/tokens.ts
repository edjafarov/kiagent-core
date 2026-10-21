/**
 * Signed capability tokens for outbox confirm/cancel URLs
 * (spec §5): HMAC(secret, draftId ‖ expiry). No server-side token table —
 * single-use falls out of the outbox state machine (any non-'draft' status
 * kills the link regardless of TTL).
 */
import { createHmac, timingSafeEqual } from 'crypto';

function sig(secret: Buffer, payload: string): Buffer {
  return createHmac('sha256', secret).update(payload).digest();
}

export function signConfirmToken(
  secret: Buffer,
  draftId: string,
  expiresAtMs: number,
): string {
  const payload = `${draftId}.${expiresAtMs}`;
  return `${payload}.${sig(secret, payload).toString('base64url')}`;
}

export function verifyConfirmToken(
  secret: Buffer,
  token: string,
  nowMs: number,
): { draftId: string; expiresAtMs: number } | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [draftId, expStr, mac] = parts;
  const expiresAtMs = Number(expStr);
  if (!draftId || !Number.isFinite(expiresAtMs)) return null;
  const expected = sig(secret, `${draftId}.${expStr}`);
  let given: Buffer;
  try {
    given = Buffer.from(mac, 'base64url');
  } catch {
    return null;
  }
  if (given.length !== expected.length) return null;
  if (!timingSafeEqual(given, expected)) return null;
  if (nowMs > expiresAtMs) return null;
  return { draftId, expiresAtMs };
}

/**
 * Event-draft tokens (calendar-out, spec §5.3): the MAC covers a domain
 * prefix AND the revision — `ev:${draftId}.${revision}.${expiry}` — so a
 * mail token never verifies as an event token (and vice versa), and a link
 * minted for revision 1 is dead once revision 2 exists. Expiry is returned,
 * not enforced, so the page can say "expired" rather than "invalid".
 */
export function signEventToken(
  secret: Buffer,
  draftId: string,
  revision: number,
  expiresAtMs: number,
): string {
  const body = `${draftId}.${revision}.${expiresAtMs}`;
  return `${body}.${sig(secret, `ev:${body}`).toString('base64url')}`;
}

export function verifyEventToken(
  secret: Buffer,
  token: string,
): { draftId: string; revision: number; expiresAtMs: number } | null {
  const parts = token.split('.');
  if (parts.length !== 4) return null;
  const [draftId, revStr, expStr, mac] = parts;
  const revision = Number(revStr);
  const expiresAtMs = Number(expStr);
  if (!draftId || !Number.isInteger(revision) || !Number.isFinite(expiresAtMs))
    return null;
  const expected = sig(secret, `ev:${draftId}.${revStr}.${expStr}`);
  const given = Buffer.from(mac, 'base64url');
  if (given.length !== expected.length) return null;
  if (!timingSafeEqual(given, expected)) return null;
  return { draftId, revision, expiresAtMs };
}
