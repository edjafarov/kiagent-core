/** Pure id helpers for the IMAP source. No I/O. */

/** Remove one pair of surrounding angle brackets and trim whitespace. */
export function stripAngle(raw: string): string {
  const s = raw.trim();
  if (s.startsWith('<') && s.endsWith('>')) return s.slice(1, -1).trim();
  return s;
}

/**
 * The Document.externalId scheme for one message: mailbox path + the
 * UIDVALIDITY it was fetched under + its UID. UIDVALIDITY is folded in (not
 * just UID) so that a server-side UIDVALIDITY rollover — which invalidates
 * every previously-assigned UID — cannot alias a stale externalId onto a
 * different message.
 */
export function buildExternalId(
  mailbox: string,
  uidValidity: string,
  uid: number,
): string {
  return `${mailbox}:${uidValidity}:${uid}`;
}
