/** Outlook .pst → one `email.message` child per message, page by page. The
 *  position is (folder in DFS order, row index) and every page re-walks the
 *  folder tree (a few ms; a PST has tens of folders) and reopens the file
 *  (1 ms), so nothing survives in the child between pages. Pure (converter
 *  child). Library internals: pst-tables.ts. */
import path from 'node:path';

import { simpleParser, type AddressObject } from 'mailparser';
import type { PSTFile, PSTFolder, PSTMessage } from 'pst-extractor';

import { extractMessageEvidence } from '@main/sources/email-evidence';
import { isAutomatedMessage } from '@main/sources/imap/filter';

import { capMarkdown } from '../formats/limits';
import { rtfToText } from '../formats/rtf';
import { htmlToMarkdown, renderMail } from '../parsers';
import { headerFields, MAX_MESSAGE_BYTES } from './mbox';
import {
  childAt,
  loadFolder,
  PSTFile as PstFileClass,
  attachmentNamesOf,
  propSize,
  rawProp,
  recipientsOf,
  rowLimit,
  subfolderNids,
} from './pst-tables';
import {
  ContainerBusyError,
  type ChildItem,
  type ExpandBudget,
  type ExpandResult,
} from './types';

export interface PstResume {
  /** Index into the DFS list of folders with content, and that folder's
   *  NID (a mismatch on resume = the tree changed: restart). */
  fi: number;
  nid: number;
  /** Next row of that folder's contents table. */
  child: number;
  count: number;
  skipped: number;
  first: string | null;
  last: string | null;
  /** Messages per folder, indexed like `fi`. */
  byFolder: number[];
}

/** Folders visited per walk (empty ones included); past it the walk stops
 *  and the summary says so. */
export const PST_LIMITS = { folders: 2000 };
const SUBFOLDER_CHUNK = 256;
/** Raw (decompressed) RTF accepted; an RTF body with pictures is large. */
const MAX_RTF_RAW = 32 * 1024 * 1024;

const PR_BODY = 0x1000;
const PR_BODY_HTML = 0x1013;
const PR_RTF_COMPRESSED = 0x1009;

/** Root containers a user never named (PST and OST layouts). */
const ROOT_SEGMENTS = new Set([
  'Top of Personal Folders',
  'Root - Mailbox',
  'IPM_SUBTREE',
]);

interface FolderRef {
  nid: number;
  label: string;
}

function open(file: string): PSTFile {
  try {
    return new PstFileClass(file);
  } catch (e) {
    const { code } = e as NodeJS.ErrnoException;
    if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES')
      throw new ContainerBusyError(`pst: ${code} ${path.basename(file)}`);
    if (/Invalid file header/.test(String((e as Error).message)))
      throw new Error(`pst: not a PST file (${path.basename(file)})`);
    throw e;
  }
}

/** Folders with content, depth first, at most PST_LIMITS.folders visited. */
function walkFolders(pst: PSTFile): { folders: FolderRef[]; capped: boolean } {
  const folders: FolderRef[] = [];
  let visited = 0;
  let capped = false;
  const visit = (folder: PSTFolder, names: string[]): void => {
    visited += 1;
    if (folder.contentCount > 0)
      folders.push({
        nid: folder.descriptorNodeId.toNumber(),
        label: names.filter((n) => !ROOT_SEGMENTS.has(n)).join(' / '),
      });
    for (let from = 0; ; from += SUBFOLDER_CHUNK) {
      const nids = subfolderNids(folder, from, SUBFOLDER_CHUNK);
      for (const nid of nids) {
        if (visited >= PST_LIMITS.folders) {
          capped = true;
          return;
        }
        let sub: PSTFolder | null = null;
        try {
          sub = loadFolder(pst, nid);
        } catch {
          sub = null; // a damaged folder: its messages are unreachable
        }
        if (sub) visit(sub, [...names, sub.displayName]);
        if (capped) return;
      }
      if (nids.length < SUBFOLDER_CHUNK) return;
    }
  };
  visit(pst.getRootFolder(), []);
  return { folders, capped };
}

const isAddr = (s: string | null | undefined): s is string =>
  !!s && /^[^\s@<>]+@[^\s@<>]+$/.test(s.trim());

const withName = (name: string, addr: string) =>
  name && name !== addr ? `${name} <${addr}>` : addr;

async function headerFrom(headers: string): Promise<string | null> {
  const head = headers.split(/\r?\n\r?\n/)[0];
  if (!/^from:/im.test(head)) return null;
  const mail = await simpleParser(Buffer.from(`${head}\r\n\r\n`, 'utf8'));
  const from = mail.from as AddressObject | undefined;
  const v = from?.value?.[0];
  return v && isAddr(v.address) ? withName(v.name ?? '', v.address) : null;
}

/** The sender as `Name <addr>`: transport header, then the SMTP-valued
 *  properties, else the display name alone (an Exchange DN is no address). */
export async function fromOf(m: PSTMessage): Promise<string> {
  const header = await headerFrom(m.transportMessageHeaders ?? '').catch(
    () => null,
  );
  if (header) return header;
  const name = (m.sentRepresentingName || m.senderName || '').trim();
  for (const a of [m.sentRepresentingEmailAddress, m.senderEmailAddress])
    if (isAddr(a)) return withName(name, a.trim());
  return name;
}

/** Recipients kept per message (a memo to a whole company lists hundreds). */
const MAX_RECIPIENTS = 200;
/** Attachment names listed per message. */
const MAX_ATTACHMENTS = 100;

function recipients(
  pst: PSTFile,
  m: PSTMessage,
): { to: string[]; cc: string[] } {
  const to: string[] = [];
  const cc: string[] = [];
  let rows: ReturnType<typeof recipientsOf>;
  try {
    rows = recipientsOf(pst, m, MAX_RECIPIENTS);
  } catch {
    return { to, cc }; // a damaged recipient table: the message still counts
  }
  for (const r of rows) {
    const addr = [r.smtpAddress, r.emailAddress].find(isAddr);
    const name = (r.displayName ?? '').trim();
    const v = addr ? withName(name, addr.trim()) : name;
    if (!v) continue;
    if (r.recipientType === 2) cc.push(v);
    else if (r.recipientType === 1) to.push(v);
  }
  return { to, cc };
}

const isMail = (cls: string) => /^ipm\.(note|schedule\.meeting)/i.test(cls);

type Body = { text: string; html: string | null; truncated: boolean };

/** The body; a damaged one (bad block ref, bad LZFu) leaves the message
 *  headers-only rather than dropping it. */
async function bodyOf(m: PSTMessage): Promise<Body> {
  try {
    return await readBody(m);
  } catch {
    return { text: '', html: null, truncated: false };
  }
}

/** The body as markdown, never reading a property past its size cap. */
async function readBody(m: PSTMessage): Promise<Body> {
  const cut = (s: string) => s.slice(0, MAX_MESSAGE_BYTES);
  const plain = propSize(m, PR_BODY);
  if (plain > 0 && plain <= MAX_MESSAGE_BYTES && m.body.trim())
    return { text: cut(m.body), html: null, truncated: false };
  const htmlSize = propSize(m, PR_BODY_HTML);
  if (htmlSize > 0 && htmlSize <= MAX_MESSAGE_BYTES) {
    const html = cut(m.bodyHTML);
    if (html.trim())
      return { text: await htmlToMarkdown(html), html, truncated: false };
  }
  const rtfSize = propSize(m, PR_RTF_COMPRESSED);
  if (rtfSize > 16 && rtfSize <= MAX_MESSAGE_BYTES) {
    const raw = rawProp(m, PR_RTF_COMPRESSED);
    // LZFu header: compressed size, raw size (bytes 4–7), magic, CRC.
    if (raw && raw.length > 16 && raw.readUInt32LE(4) <= MAX_RTF_RAW) {
      const text = rtfToText(m.bodyRTF);
      if (text.trim()) return { text, html: null, truncated: false };
    }
  }
  const tooBig = [plain, htmlSize, rtfSize].some((n) => n > MAX_MESSAGE_BYTES);
  return { text: '', html: null, truncated: tooBig };
}

const stripAngle = (s: string) => s.trim().replace(/^<|>$/g, '').trim();
const iso = (d: Date | null) =>
  d && !Number.isNaN(d.getTime()) ? d.toISOString() : null;

async function messageChild(
  pst: PSTFile,
  m: PSTMessage,
  folder: string,
): Promise<ChildItem | null> {
  const headerText = m.transportMessageHeaders ?? '';
  const headers: Record<string, string> = {};
  for (const [k, v] of headerFields(headerText.split(/\r?\n\r?\n/)[0]))
    headers[k.toLowerCase()] = v;
  const from = await fromOf(m);
  if (isAutomatedMessage(headers, from).matched) return null;

  const nid = m.descriptorNodeId.toNumber();
  const date = iso(m.clientSubmitTime) ?? iso(m.messageDeliveryTime);
  const { to, cc } = recipients(pst, m);
  const subject = (m.subject ?? '').trim();
  const body = await bodyOf(m);
  const attachments = attachmentNamesOf(m, MAX_ATTACHMENTS);
  let markdown = renderMail({
    subject: subject || undefined,
    from: from || undefined,
    to: to.join(', ') || undefined,
    cc: cc.join(', ') || undefined,
    date: date ? new Date(date) : undefined,
    attachments,
    body: body.text,
  });
  if (body.truncated) markdown += '\n\n[truncated]';
  const messageId = m.internetMessageId
    ? stripAngle(m.internetMessageId)
    : null;
  const key = `pst:${nid}`;
  const evidence = extractMessageEvidence({
    messageKey: messageId ?? key,
    author: from,
    at: date,
    plain: body.html ? '' : body.text,
    html: body.html,
  });
  return {
    key,
    type: 'email.message',
    title: subject || '(no subject)',
    markdown: capMarkdown(markdown).markdown,
    metadata: {
      from: from || null,
      to,
      cc,
      replyTo: null,
      references: m.inReplyToId ? [stripAngle(m.inReplyToId)] : [],
      date,
      subject: subject || null,
      messageId,
      folder,
      ...(evidence.author
        ? { contactEvidence: { version: 1 as const, messages: [evidence] } }
        : {}),
      ...(body.truncated ? { truncated: true } : {}),
    },
    createdAt: date,
  };
}

const year = (s: string | null) => (s ? s.slice(0, 4) : null);

function summary(
  file: string,
  s: PstResume,
  folders: FolderRef[],
  capped: boolean,
): string {
  const n = s.count.toLocaleString('en-US');
  const [a, b] = [year(s.first), year(s.last)];
  const span = a && b ? (a === b ? `, ${a}` : `, ${a}–${b}`) : '';
  const lines = [
    `# ${path.basename(file)} — ${n} message${s.count === 1 ? '' : 's'}${span}`,
  ];
  const top = folders
    .map((f, i) => ({ label: f.label || '(top)', n: s.byFolder[i] ?? 0 }))
    .filter((f) => f.n > 0)
    .sort((x, y) => y.n - x.n)
    .slice(0, 10);
  if (top.length > 0) {
    lines.push('');
    for (const f of top)
      lines.push(`- ${f.label} — ${f.n.toLocaleString('en-US')}`);
  }
  if (capped)
    lines.push(
      '',
      `Only the first ${PST_LIMITS.folders.toLocaleString('en-US')} folders were read.`,
    );
  return lines.join('\n');
}

export async function expandPst(
  file: string,
  resume: PstResume | null,
  budget: ExpandBudget,
): Promise<ExpandResult> {
  const t0 = Date.now();
  const pst = open(file);
  try {
    const { folders, capped } = walkFolders(pst);
    const state: PstResume = resume
      ? { ...resume, byFolder: [...resume.byFolder] }
      : {
          fi: 0,
          nid: folders[0]?.nid ?? 0,
          child: 0,
          count: 0,
          skipped: 0,
          first: null,
          last: null,
          byFolder: [],
        };
    if (resume && folders[resume.fi]?.nid !== resume.nid)
      return { items: [], resume: null, restart: true };

    const items: ChildItem[] = [];
    let bytes = 0;
    while (state.fi < folders.length) {
      const ref = folders[state.fi];
      let folder: PSTFolder | null;
      try {
        folder = loadFolder(pst, ref.nid);
      } catch {
        folder = null;
      }
      if (!folder) return { items: [], resume: null, restart: true };
      // Fewer rows than the saved position: the folder changed in place.
      if (state.child > rowLimit(folder))
        return { items: [], resume: null, restart: true };
      for (;;) {
        const at = childAt(pst, folder, state.child);
        if (at.end) break;
        state.child += 1;
        let child: ChildItem | null = null;
        if (at.skipped) state.skipped += 1;
        else if (at.message && isMail(at.message.messageClass ?? ''))
          try {
            // eslint-disable-next-line no-await-in-loop
            child = await messageChild(pst, at.message, ref.label);
          } catch {
            state.skipped += 1; // one bad message never fails the archive
          }
        if (child) {
          items.push(child);
          bytes += Buffer.byteLength(child.markdown ?? '');
          state.count += 1;
          state.byFolder[state.fi] = (state.byFolder[state.fi] ?? 0) + 1;
          const d = child.createdAt;
          if (d && (!state.first || d < state.first)) state.first = d;
          if (d && (!state.last || d > state.last)) state.last = d;
        }
        if (
          items.length >= budget.items ||
          bytes >= budget.bytes ||
          Date.now() - t0 >= budget.ms
        )
          return { items, resume: { ...state } };
      }
      state.fi += 1;
      state.child = 0;
      state.nid = folders[state.fi]?.nid ?? 0;
    }
    return {
      items,
      resume: null,
      summary: summary(file, state, folders, capped),
    };
  } finally {
    pst.close();
  }
}
