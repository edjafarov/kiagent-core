/** mbox → one `email.message` child per message, page by page from a byte
 *  offset. Thunderbird folders (extensionless mbox) included: expunged
 *  messages are skipped and the status headers Thunderbird rewrites in place
 *  never change a message's id. Pure (converter child). */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { simpleParser, type AddressObject } from 'mailparser';

import { extractMessageEvidence } from '@main/sources/email-evidence';
import { isAutomatedMessage } from '@main/sources/imap/filter';

import { capMarkdown } from '../formats/limits';
import { htmlToMarkdown, renderMail } from '../parsers';
import { readRecords } from './records';
import type { ChildItem, ExpandBudget, ExpandResult } from './types';

/** Raw bytes handed to the mail parser per message; the tail of a larger
 *  message (normally base64 attachments) is dropped unparsed. */
export const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;

export interface MboxResume {
  offset: number;
  count: number;
  first: string | null;
  last: string | null;
  /** Set on a `tail`: the offset must still be a message boundary. */
  append?: true;
}

/** Headers that change without the message changing (Thunderbird rewrites
 *  them in place on read/flag), so they never feed a fallback id. */
const VOLATILE_HEADER = /^(x-mozilla-.*|status|x-status)$/i;

const sha1 = (s: string | Buffer) => createHash('sha1').update(s).digest('hex');

const isFromLine = (line: Buffer, prevBlank: boolean): boolean => {
  if (line.length < 5 || line.toString('latin1', 0, 5) !== 'From ')
    return false;
  // A blank line before it, or an envelope date (a year at the end):
  // tolerates writers that omit the blank separator line.
  return prevBlank || /\d{4}\s*$/.test(line.toString('latin1', 0, 200));
};

/** The header block as unfolded `[name, value]` pairs (latin1, raw). */
export function headerFields(head: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const line of head.split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && out.length > 0) {
      out[out.length - 1][1] += ` ${line.trim()}`;
      continue;
    }
    const colon = line.indexOf(':');
    if (colon > 0)
      out.push([line.slice(0, colon).trim(), line.slice(colon + 1).trim()]);
  }
  return out;
}

const addrList = (a: AddressObject | AddressObject[] | undefined): string[] =>
  (a ? (Array.isArray(a) ? a : [a]) : [])
    .flatMap((obj) =>
      obj.value.map((v) =>
        v.name ? `${v.name} <${v.address ?? ''}>` : (v.address ?? ''),
      ),
    )
    .filter(Boolean);

const stripAngle = (s: string) => s.trim().replace(/^<|>$/g, '').trim();

/** One raw record → a child, or null when it is skipped (expunged,
 *  automated, empty). */
async function messageChild(
  record: Buffer,
  truncated: boolean,
): Promise<ChildItem | null> {
  // Drop the `From ` envelope line; undo mboxrd/mboxo `>From ` quoting.
  let text = record.toString('latin1');
  text = text.slice(text.indexOf('\n') + 1).replace(/^>(>*From )/gm, '$1');
  const split = /\r?\n\r?\n/.exec(text);
  const head = split ? text.slice(0, split.index) : text;
  const fields = headerFields(head);
  const status = fields.find(([k]) => k.toLowerCase() === 'x-mozilla-status');
  if (status && (parseInt(status[1], 16) & 0x0008) !== 0) return null;
  if (!head.trim()) return null;

  const raw = Buffer.from(text, 'latin1');
  const mail = await simpleParser(raw);
  const headers: Record<string, string> = {};
  for (const [k, v] of fields) headers[k.toLowerCase()] = v;
  const from = addrList(mail.from)[0] ?? '';
  if (isAutomatedMessage(headers, from).matched) return null;

  const messageId = mail.messageId ? stripAngle(mail.messageId) : null;
  const key = `msg:${sha1(
    messageId ??
      fields
        .filter(([k]) => !VOLATILE_HEADER.test(k))
        .map(([k, v]) => `${k}:${v}`)
        .join('\n'),
  )}`;
  const date =
    mail.date && !Number.isNaN(mail.date.getTime()) ? mail.date : null;
  const html = typeof mail.html === 'string' ? mail.html : null;
  const body = mail.text?.trim()
    ? mail.text
    : html
      ? await htmlToMarkdown(html)
      : '';
  const to = addrList(mail.to);
  const cc = addrList(mail.cc);
  const subject = mail.subject?.trim() || '';
  let markdown = renderMail({
    subject: subject || undefined,
    from: from || undefined,
    to: to.join(', ') || undefined,
    cc: cc.join(', ') || undefined,
    date: date ?? undefined,
    attachments: (mail.attachments ?? [])
      .map((a) => a.filename)
      .filter((n): n is string => Boolean(n)),
    body,
  });
  if (truncated) markdown += '\n\n[truncated]';
  const evidence = extractMessageEvidence({
    messageKey: messageId ?? key,
    author: from,
    at: date?.toISOString() ?? null,
    plain: mail.text ?? '',
    html,
  });
  const references = (
    Array.isArray(mail.references)
      ? mail.references
      : mail.references
        ? [mail.references]
        : []
  ).map(stripAngle);
  return {
    key,
    type: 'email.message',
    title: subject || '(no subject)',
    markdown: capMarkdown(markdown).markdown,
    metadata: {
      from: from || null,
      to,
      cc,
      replyTo: addrList(mail.replyTo)[0] ?? null,
      references,
      date: date?.toISOString() ?? null,
      subject: subject || null,
      messageId,
      ...(evidence.author
        ? { contactEvidence: { version: 1 as const, messages: [evidence] } }
        : {}),
      ...(truncated ? { truncated: true } : {}),
    },
    createdAt: date?.toISOString() ?? null,
  };
}

const year = (iso: string | null) => (iso ? iso.slice(0, 4) : null);

function summary(file: string, s: MboxResume): string {
  const n = s.count.toLocaleString('en-US');
  const label = `${n} message${s.count === 1 ? '' : 's'}`;
  const [a, b] = [year(s.first), year(s.last)];
  const span = a && b ? (a === b ? `, ${a}` : `, ${a}–${b}`) : '';
  return `# ${path.basename(file)} — ${label}${span}`;
}

async function startsWithFrom(file: string, offset: number): Promise<boolean> {
  const fh = await fs.promises.open(file, 'r');
  try {
    const buf = Buffer.alloc(5);
    const { bytesRead } = await fh.read(buf, 0, 5, offset);
    return bytesRead === 5 && buf.toString('latin1') === 'From ';
  } finally {
    await fh.close();
  }
}

export async function expandMbox(
  file: string,
  resume: MboxResume | null,
  budget: ExpandBudget,
): Promise<ExpandResult> {
  const state: MboxResume = resume
    ? {
        offset: resume.offset,
        count: resume.count,
        first: resume.first,
        last: resume.last,
      }
    : { offset: 0, count: 0, first: null, last: null };
  if (resume?.append) {
    // A tail read past the size the source noted (the file grew while it
    // was read) lands on EOF: nothing new, not a broken boundary.
    const { size } = await fs.promises.stat(file);
    if (resume.offset === size)
      return {
        items: [],
        resume: null,
        summary: summary(file, state),
        tail: { ...state, append: true },
      };
    if (resume.offset > size || !(await startsWithFrom(file, resume.offset)))
      return { items: [], resume: null, restart: true };
  }

  const t0 = Date.now();
  const items: ChildItem[] = [];
  let bytes = 0;
  for await (const rec of readRecords(file, state.offset, {
    isStart: isFromLine,
    maxRecordBytes: MAX_MESSAGE_BYTES,
  })) {
    state.offset = rec.end;
    const child = await messageChild(rec.raw, rec.truncated);
    if (child) {
      items.push(child);
      bytes += Buffer.byteLength(child.markdown ?? '');
      state.count += 1;
      const at = child.createdAt;
      if (at && (!state.first || at < state.first)) state.first = at;
      if (at && (!state.last || at > state.last)) state.last = at;
    }
    if (
      items.length >= budget.items ||
      bytes >= budget.bytes ||
      Date.now() - t0 >= budget.ms
    )
      return { items, resume: { ...state } };
  }
  return {
    items,
    resume: null,
    summary: summary(file, state),
    tail: { ...state, append: true },
  };
}
