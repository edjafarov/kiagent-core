import { createHash } from 'node:crypto';
import TurndownService from 'turndown';
import type { MessageEvidenceV1 } from '@shared/message-evidence';

const MAX_SIGNATURE = 1200;
const MAX_EXCERPT = 800;
const DISCLAIMER =
  /(?:this e[- ]?mail|this message|any attachments|confidential|vertraulich|unsubscribe|abmelden|désinscription).{0,120}/i;
const SIGNOFF =
  /^(?:best(?: regards)?|kind regards|regards|thanks|thank you|cheers|sincerely|many thanks|mit freundlichen grüßen|viele grüße|freundliche grüße)[,!]?$/i;

export function normalizeAuthor(input: string): string {
  const match =
    /<\s*([^<>\s]+@[^<>\s]+)\s*>/.exec(input) ??
    /(?:^|\s)([^\s<>]+@[^\s<>]+)(?:$|\s)/.exec(input);
  if (!match) return '';
  const author = match[1].toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(author) ? author : '';
}

export function extractMessageEvidence(input: {
  messageKey: string;
  author: string;
  at: string | null;
  plain: string;
  html: string | null;
}): MessageEvidenceV1 {
  const author = normalizeAuthor(input.author);
  const source =
    input.plain.trim() || (input.html ? htmlToText(input.html) : '');
  const { body, signature } = splitSignature(removeQuoted(source));
  const evidence = {
    version: 1 as const,
    messageKey: input.messageKey || 'message',
    author,
    at: input.at,
    signature: author && signature ? signature.slice(0, MAX_SIGNATURE) : null,
    excerpt: body.slice(0, MAX_EXCERPT),
  };
  return {
    ...evidence,
    fingerprint: createHash('sha256')
      .update(JSON.stringify(evidence))
      .digest('hex'),
  };
}

/** Never throws: one unreadable message must not stall a whole mail sync.
 *  Turndown throws on HTML it cannot root (a `<frameset>` page — old
 *  newsletters and bank mail); those fall back to the page's bare text. */
export function htmlToText(html: string): string {
  let text: string;
  try {
    const td = new TurndownService({
      headingStyle: 'atx',
      bulletListMarker: '-',
    });
    // Mail HTML carries <head> CSS whose text is not content, and images that
    // are logos or tracking pixels: keep what an image says, not where it is.
    td.remove(['head', 'title', 'style', 'script', 'noscript']);
    td.addRule('imageAlt', {
      filter: 'img',
      replacement: (_content, node) =>
        ((node as HTMLElement).getAttribute('alt') ?? '').trim(),
    });
    text = td.turndown(html);
  } catch {
    text = bareText(html);
  }
  return text.replace(/\n{3,}/g, '\n\n').trim();
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function bareText(html: string): string {
  return html
    .replace(/<(script|style|head|title)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<\/?(p|div|br|tr|li|h[1-6]|table|noframes)\b[^>]*>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] !== '#') return ENTITIES[e.toLowerCase()] ?? m;
      const n =
        e[1] === 'x' || e[1] === 'X'
          ? parseInt(e.slice(2), 16)
          : parseInt(e.slice(1), 10);
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
    })
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n');
}

function removeQuoted(text: string): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  for (const line of lines) {
    if (
      /^\s*>/.test(line) ||
      /^\s*(?:on .+ wrote:|am .+ schrieb .+:|-{2,}\s*original message\s*-*|begin forwarded message)\s*$/i.test(
        line,
      )
    )
      break;
    out.push(line);
  }
  return out.join('\n').trim();
}

function splitSignature(text: string): {
  body: string;
  signature: string | null;
} {
  const lines = text.split('\n').map((line) => line.trimEnd());
  const separator = lines.findIndex((line) =>
    /^\s*(?:--\s*|_{2,}|-{3,})$/.test(line),
  );
  let signatureStart = separator >= 0 ? separator + 1 : -1;
  if (signatureStart < 0) {
    for (let i = Math.max(0, lines.length - 10); i < lines.length; i++)
      if (SIGNOFF.test(lines[i].trim())) {
        signatureStart = i;
        break;
      }
  }
  if (signatureStart < 0) return { body: cleanExcerpt(text), signature: null };
  const candidateLines = lines.slice(signatureStart);
  const boilerplate = candidateLines.findIndex((line) => DISCLAIMER.test(line));
  const authoredLines =
    boilerplate >= 0 ? candidateLines.slice(0, boilerplate) : candidateLines;
  const candidate = authoredLines.join('\n').trim();
  return {
    body: cleanExcerpt(
      lines.slice(0, separator >= 0 ? separator : signatureStart).join('\n'),
    ),
    signature: candidate || null,
  };
}

function cleanExcerpt(text: string): string {
  return text.replace(/\n{3,}/g, '\n\n').trim();
}
