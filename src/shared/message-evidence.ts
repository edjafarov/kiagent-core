import { createHash } from 'node:crypto';
import TurndownService from 'turndown';

export interface MessageEvidenceV1 {
  version: 1;
  messageKey: string;
  author: string;
  at: string | null;
  signature: string | null;
  excerpt: string;
  fingerprint: string;
}

const MAX_SIGNATURE = 1200;
const MAX_EXCERPT = 800;
const DISCLAIMER =
  /(?:this e[- ]?mail|this message|any attachments).{0,80}(?:confidential|intended only|privileged|disclosure)/i;
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
  const own = removeQuoted(source);
  const { body, signature } = splitSignature(own);
  const evidence = {
    version: 1 as const,
    messageKey: input.messageKey || 'message',
    author,
    at: input.at,
    signature: author && signature ? signature.slice(0, MAX_SIGNATURE) : null,
    excerpt: body.slice(0, MAX_EXCERPT),
  };
  const canonical = JSON.stringify(evidence);
  return {
    ...evidence,
    fingerprint: createHash('sha256').update(canonical).digest('hex'),
  };
}

function htmlToText(html: string): string {
  const turndown = new TurndownService({
    headingStyle: 'atx',
    bulletListMarker: '-',
  });
  return turndown
    .turndown(html)
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function removeQuoted(text: string): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  for (const line of lines) {
    if (
      /^\s*>/.test(line) ||
      /^\s*(?:on .+ wrote:|-{2,}\s*original message|begin forwarded message)\s*$/i.test(
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
    for (let i = Math.max(0, lines.length - 10); i < lines.length; i++) {
      if (SIGNOFF.test(lines[i].trim())) {
        signatureStart = i;
        break;
      }
    }
  }
  if (signatureStart < 0) return { body: cleanExcerpt(text), signature: null };
  const candidate = lines.slice(signatureStart).join('\n').trim();
  if (
    !candidate ||
    (DISCLAIMER.test(candidate) && candidate.split('\n').length <= 3)
  ) {
    return {
      body: cleanExcerpt(
        lines.slice(0, separator >= 0 ? separator : signatureStart).join('\n'),
      ),
      signature: null,
    };
  }
  return {
    body: cleanExcerpt(
      lines.slice(0, separator >= 0 ? separator : signatureStart).join('\n'),
    ),
    signature: candidate,
  };
}

function cleanExcerpt(text: string): string {
  return text.replace(/\n{3,}/g, '\n\n').trim();
}
