/** vCard (.vcf) → one `contact.card` child per card: name, organization,
 *  title, emails, phones, addresses, note. Photos, logos, sounds and keys
 *  are dropped. Handles 2.1 (quoted-printable, CHARSET), 3.0 and 4.0, folded
 *  lines and grouped properties (`item1.EMAIL`). Pure (converter child). */
import { createHash } from 'node:crypto';
import path from 'node:path';

import { readRecords } from './records';
import type { ChildItem, ExpandBudget, ExpandResult } from './types';

const MAX_CARD_BYTES = 8 * 1024 * 1024;
const DROPPED = new Set(['PHOTO', 'LOGO', 'SOUND', 'KEY']);

export interface VcardResume {
  offset: number;
  count: number;
}

interface Prop {
  name: string;
  params: Record<string, string>;
  value: string;
}

const sha1 = (s: string) => createHash('sha1').update(s).digest('hex');

const line = (buf: Buffer) => buf.toString('latin1').trim().toUpperCase();

/** Unfold continuation lines (and 2.1 quoted-printable soft breaks). */
function unfold(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const prev = out.length - 1;
    if (/^[ \t]/.test(raw) && prev >= 0) out[prev] += raw.slice(1);
    else if (
      prev >= 0 &&
      /ENCODING=QUOTED-PRINTABLE/i.test(out[prev]) &&
      out[prev].endsWith('=')
    )
      out[prev] = out[prev].slice(0, -1) + raw;
    else out.push(raw);
  }
  return out.filter((l) => l.trim());
}

function decodeQp(value: string, charset: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < value.length; i++) {
    const hex = value.slice(i + 1, i + 3);
    if (value[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(hex)) {
      bytes.push(parseInt(hex, 16));
      i += 2;
    } else bytes.push(value.charCodeAt(i) & 0xff);
  }
  try {
    return new TextDecoder(charset).decode(new Uint8Array(bytes));
  } catch {
    return new TextDecoder('utf-8').decode(new Uint8Array(bytes));
  }
}

const unescape = (v: string) =>
  v.replace(/\\([nN,;\\])/g, (_, c: string) =>
    c === 'n' || c === 'N' ? '\n' : c,
  );

function parseProp(l: string): Prop | null {
  // The value starts after the first ':' outside a quoted parameter value.
  let quoted = false;
  let colon = -1;
  for (let i = 0; i < l.length; i++) {
    if (l[i] === '"') quoted = !quoted;
    else if (l[i] === ':' && !quoted) {
      colon = i;
      break;
    }
  }
  if (colon < 0) return null;
  const [rawName, ...rawParams] = l.slice(0, colon).split(';');
  const name = rawName.split('.').pop()!.toUpperCase();
  const params: Record<string, string> = {};
  for (const p of rawParams) {
    const eq = p.indexOf('=');
    if (eq < 0) params.TYPE = params.TYPE ? `${params.TYPE},${p}` : p;
    else
      params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/"/g, '');
  }
  let value = l.slice(colon + 1);
  if (/^quoted-printable$/i.test(params.ENCODING ?? ''))
    value = decodeQp(value, params.CHARSET ?? 'utf-8');
  return { name, params, value };
}

const parts = (v: string) => v.split(/(?<!\\);/).map((p) => unescape(p).trim());

function cardChild(raw: Buffer): ChildItem | null {
  // vCard 3/4 is UTF-8; 2.1 non-ASCII is quoted-printable with a CHARSET.
  const props = unfold(raw.toString('utf8'))
    .map(parseProp)
    .filter((p): p is Prop => p !== null && !DROPPED.has(p.name));
  const all = (n: string) => props.filter((p) => p.name === n);
  const one = (n: string) => all(n)[0]?.value;
  const n = one('N');
  const nameFromN = n
    ? (() => {
        const [family, given, middle, prefix, suffix] = parts(n);
        return [prefix, given, middle, family, suffix]
          .filter(Boolean)
          .join(' ');
      })()
    : '';
  const emails = all('EMAIL')
    .map((p) => unescape(p.value).trim())
    .filter(Boolean);
  const phones = all('TEL')
    .map((p) => unescape(p.value).trim())
    .filter(Boolean);
  const fn = one('FN') ? unescape(one('FN')!).trim() : '';
  const name = fn || nameFromN || emails[0] || '';
  if (!name && phones.length === 0) return null;
  const org = one('ORG') ? parts(one('ORG')!).filter(Boolean).join(' / ') : '';
  const title = one('TITLE') ? unescape(one('TITLE')!).trim() : '';
  const addresses = all('ADR')
    .map((p) => parts(p.value).filter(Boolean).join(', '))
    .filter(Boolean);
  const note = one('NOTE') ? unescape(one('NOTE')!).trim() : '';
  const uid = one('UID')?.trim();

  const md = [`# ${name || phones[0]}`];
  if (org) md.push(`**Organization:** ${org}`);
  if (title) md.push(`**Title:** ${title}`);
  if (emails.length) md.push(`**Email:** ${emails.join(', ')}`);
  if (phones.length) md.push(`**Phone:** ${phones.join(', ')}`);
  for (const a of addresses) md.push(`**Address:** ${a}`);
  if (note) md.push(note);
  return {
    key: `vcf:${sha1(uid || `${name}\n${emails[0] ?? ''}`)}`,
    type: 'contact.card',
    title: name || phones[0],
    markdown: md.join('\n\n'),
    metadata: {
      name: name || null,
      emails,
      phones,
      organization: org || null,
      title: title || null,
      ...(uid ? { uid } : {}),
    },
    createdAt: null,
  };
}

export async function expandVcard(
  file: string,
  resume: VcardResume | null,
  budget: ExpandBudget,
): Promise<ExpandResult> {
  const state: VcardResume = resume ? { ...resume } : { offset: 0, count: 0 };
  const t0 = Date.now();
  const items: ChildItem[] = [];
  let bytes = 0;
  for await (const rec of readRecords(file, state.offset, {
    isStart: (l) => line(l) === 'BEGIN:VCARD',
    isEnd: (l) => line(l) === 'END:VCARD',
    maxRecordBytes: MAX_CARD_BYTES,
  })) {
    state.offset = rec.end;
    const child = cardChild(rec.raw);
    if (child) {
      items.push(child);
      bytes += Buffer.byteLength(child.markdown ?? '');
      state.count += 1;
    }
    if (
      items.length >= budget.items ||
      bytes >= budget.bytes ||
      Date.now() - t0 >= budget.ms
    )
      return { items, resume: { ...state } };
  }
  const n = state.count.toLocaleString('en-US');
  return {
    items,
    resume: null,
    summary: `# ${path.basename(file)} — ${n} contact${state.count === 1 ? '' : 's'}`,
  };
}
