import EmailReplyParser from 'email-reply-parser';

/**
 * Strip quoted history / signatures from a plain-text email body, the way the
 * legacy gmail connector's reply-stripper.ts did (kiagent-ref's IMAP
 * connector itself never called this — it stored full per-message bodies
 * inside a rebuilt thread doc instead — but the same library is bundled here
 * and applying it per message keeps a flat `email.message` document readable).
 * Falls back to the original (trimmed) text if the parser leaves nothing
 * visible, so a message is never emptied out by an overzealous strip.
 */
export function cleanBody(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return '';
  try {
    const parsed = new EmailReplyParser().read(trimmed);
    const visible = parsed.getVisibleText().trim();
    return visible.length > 0 ? visible : trimmed;
  } catch {
    return trimmed;
  }
}
