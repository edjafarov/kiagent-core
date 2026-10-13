/** Evernote export (.enex) → one `note` child per `<note>`: ENML body via
 *  the shared HTML→markdown converter, tags, dates, source URL and the
 *  attachment (resource) file names. Notes are split by a line scanner and
 *  parsed one at a time; resource data beyond the per-note cap is dropped
 *  unparsed. Pure (converter child). */
import { createHash } from 'node:crypto';
import path from 'node:path';

import { byLocalName, parseXml, textContent } from '../formats/xml';
import { htmlToMarkdown } from '../parsers';
import { readRecords } from './records';
import type { ChildItem, ExpandBudget, ExpandResult } from './types';

const MAX_NOTE_BYTES = 8 * 1024 * 1024;

export interface EnexResume {
  offset: number;
  count: number;
}

const sha1 = (s: string) => createHash('sha1').update(s).digest('hex');

/** `20240115T101500Z` → ISO, or null. */
function enexDate(s: string): string | null {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(s.trim());
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.000Z` : null;
}

/** The `<note>…</note>` element out of a record; a truncated record loses
 *  its resources (always last in a note) and is closed by hand. */
function noteXml(raw: string, truncated: boolean): string {
  const from = raw.indexOf('<note>');
  let xml = raw.slice(from < 0 ? 0 : from);
  if (truncated) {
    const res = xml.indexOf('<resource>');
    xml = `${res < 0 ? xml : xml.slice(0, res)}</note>`;
  } else {
    const end = xml.lastIndexOf('</note>');
    if (end >= 0) xml = xml.slice(0, end + '</note>'.length);
  }
  return xml;
}

async function noteChild(
  raw: Buffer,
  truncated: boolean,
): Promise<ChildItem | null> {
  const doc = parseXml(noteXml(raw.toString('utf8'), truncated));
  const text = (name: string, root: Node = doc) => {
    const el = byLocalName(root, name)[0];
    return el ? textContent(el).trim() : '';
  };
  const title = text('title') || '(untitled)';
  const created = enexDate(text('created'));
  const updated = enexDate(text('updated'));
  const tags = byLocalName(doc, 'tag')
    .map((t) => textContent(t).trim())
    .filter(Boolean);
  const attrs = byLocalName(doc, 'note-attributes')[0];
  const sourceUrl = attrs ? text('source-url', attrs) : '';
  const author = attrs ? text('author', attrs) : '';
  const resources = byLocalName(doc, 'resource')
    .map((r) => text('file-name', r))
    .filter(Boolean);
  const enml = text('content')
    .replace(/<\?xml[^>]*\?>/g, '')
    .replace(/<!DOCTYPE[^>]*>/gi, '')
    .replace(/<en-media\b[^>]*\/?>(<\/en-media>)?/gi, '')
    .replace(/<en-todo\b[^>]*checked="true"[^>]*\/?>/gi, '☑ ')
    .replace(/<en-todo\b[^>]*\/?>/gi, '☐ ')
    .replace(/<(\/?)en-note\b[^>]*>/gi, '<$1div>');
  const body = enml.trim() ? (await htmlToMarkdown(enml)).trim() : '';

  const md = [`# ${title}`];
  if (tags.length) md.push(`**Tags:** ${tags.join(', ')}`);
  if (sourceUrl) md.push(`**Source:** ${sourceUrl}`);
  if (body) md.push(body);
  if (resources.length) md.push(`**Attachments:** ${resources.join(', ')}`);
  if (truncated) md.push('[truncated]');
  return {
    key: `enex:${sha1(`${title}\n${created ?? ''}`)}`,
    type: 'note',
    title,
    markdown: md.join('\n\n'),
    metadata: {
      tags,
      created,
      updated,
      ...(sourceUrl ? { sourceUrl } : {}),
      ...(author ? { author } : {}),
      resources,
      ...(truncated ? { truncated: true } : {}),
    },
    createdAt: created,
  };
}

export async function expandEnex(
  file: string,
  resume: EnexResume | null,
  budget: ExpandBudget,
): Promise<ExpandResult> {
  const state: EnexResume = resume ? { ...resume } : { offset: 0, count: 0 };
  const t0 = Date.now();
  const items: ChildItem[] = [];
  let bytes = 0;
  for await (const rec of readRecords(file, state.offset, {
    isStart: (l) => l.includes('<note>'),
    isEnd: (l) => l.includes('</note>'),
    maxRecordBytes: MAX_NOTE_BYTES,
  })) {
    state.offset = rec.end;
    let child: ChildItem | null = null;
    try {
      child = await noteChild(rec.raw, rec.truncated);
    } catch {
      child = null; // one malformed note never fails the export
    }
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
    summary: `# ${path.basename(file)} — ${n} note${state.count === 1 ? '' : 's'}`,
  };
}
