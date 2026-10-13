/** ZIP → one `file` child per member (Takeout, WhatsApp, LinkedIn, Slack
 *  exports…), each routed by the SAME policy as a local file: text members
 *  are decoded, document members go through the converter's parsers, media
 *  and anything over the caps become name-only children. Random access via
 *  yauzl; only one member is inflated at a time and every read is counted.
 *  Pure (converter child). */
import path from 'node:path';

import yauzl from 'yauzl';

import { decideFileIndexing } from '@shared/file-indexability';
import { resolvePathMime } from '@main/sources/local-folder/mime';

import { capMarkdown } from '../formats/limits';
import { parseDetailed } from '../parsers';
import {
  containerKindOf,
  type ChildItem,
  type ExpandBudget,
  type ExpandResult,
} from './types';

export const MAX_MEMBER_BYTES = 20 * 1024 * 1024;
export const MAX_ZIP_CHILDREN = 100_000;
const MAX_RATIO = 100;
const RATIO_FLOOR = 1024 * 1024;
const HEAD_NAMES = 50;

export interface ZipResume {
  /** Central-directory index of the next entry. */
  index: number;
  count: number;
  /** First member names, for the summary. */
  head: string[];
}

const open = (file: string): Promise<yauzl.ZipFile> =>
  new Promise((resolve, reject) =>
    yauzl.open(
      file,
      // NOT yauzl's validateEntrySizes: on a forged size its stream stalls
      // without an error (Node 24); readMember's own counter bounds it.
      { lazyEntries: true, autoClose: false, validateEntrySizes: false },
      (err, zf) =>
        err || !zf ? reject(err ?? new Error('zip: open failed')) : resolve(zf),
    ),
  );

const nextEntry = (zf: yauzl.ZipFile): Promise<yauzl.Entry | null> =>
  new Promise((resolve, reject) => {
    const done = () => {
      zf.removeListener('entry', onEntry);
      zf.removeListener('end', onEnd);
      zf.removeListener('error', onError);
    };
    const onEntry = (e: yauzl.Entry) => {
      done();
      resolve(e);
    };
    const onEnd = () => {
      done();
      resolve(null);
    };
    const onError = (e: Error) => {
      done();
      reject(e);
    };
    zf.on('entry', onEntry);
    zf.on('end', onEnd);
    zf.on('error', onError);
    zf.readEntry();
  });

/** The member's bytes, or null when it is unreadable or inflates past the
 *  cap — counted as it streams, so a forged size cannot get past it. */
const readMember = (
  zf: yauzl.ZipFile,
  e: yauzl.Entry,
): Promise<Buffer | null> =>
  new Promise((resolve) => {
    zf.openReadStream(e, (err, stream) => {
      if (err || !stream) {
        resolve(null);
        return;
      }
      const chunks: Buffer[] = [];
      let n = 0;
      let settled = false;
      const settle = (v: Buffer | null) => {
        if (settled) return;
        settled = true;
        resolve(v);
      };
      stream.on('data', (c: Buffer) => {
        n += c.length;
        if (n > MAX_MEMBER_BYTES) {
          stream.destroy();
          settle(null);
          return;
        }
        chunks.push(c);
      });
      stream.on('error', () => settle(null));
      stream.on('end', () => settle(Buffer.concat(chunks)));
    });
  });

async function memberChild(
  zf: yauzl.ZipFile,
  e: yauzl.Entry,
): Promise<ChildItem | null> {
  const member = e.fileName;
  const filename = path.posix.basename(member);
  const mime = resolvePathMime(member);
  const decision = decideFileIndexing({
    profile: 'local-folder',
    filename,
    path: member,
    mime,
    sizeBytes: e.uncompressedSize,
  });
  if (decision.kind === 'ignore') return null;
  const dot = filename.lastIndexOf('.');
  const child: ChildItem = {
    key: `zip:${member}`,
    type: 'file',
    title: filename,
    markdown: null,
    metadata: {
      member,
      filename,
      mime,
      ext: dot > 0 ? filename.slice(dot + 1).toLowerCase() : '',
      sizeBytes: e.uncompressedSize,
      mtime: e.getLastModDate().toISOString(),
    },
    createdAt: null,
  };
  const encrypted = (e.generalPurposeBitFlag & 0x1) !== 0;
  const bomb =
    e.uncompressedSize > RATIO_FLOOR &&
    e.uncompressedSize > e.compressedSize * MAX_RATIO;
  const readable =
    decision.bytes === 'eager' &&
    (decision.pipeline === 'inline-text' || decision.pipeline === 'converter');
  if (
    encrypted ||
    bomb ||
    !readable ||
    e.uncompressedSize > MAX_MEMBER_BYTES ||
    containerKindOf(filename, mime) !== null
  )
    return child; // name-only
  const bytes = await readMember(zf, e);
  if (!bytes) return child;
  if (decision.pipeline === 'inline-text') {
    if (bytes.includes(0)) return child;
    child.markdown = capMarkdown(bytes.toString('utf8')).markdown;
    return child;
  }
  try {
    const r = await parseDetailed(new Uint8Array(bytes), mime, filename);
    if (r.markdown) child.markdown = capMarkdown(r.markdown).markdown;
  } catch (err) {
    child.metadata.conversionError =
      err instanceof Error ? err.message : String(err);
  }
  return child;
}

function summary(file: string, s: ZipResume, capped: boolean): string {
  const n = s.count.toLocaleString('en-US');
  const head = `# ${path.basename(file)} — ${capped ? 'first ' : ''}${n} file${s.count === 1 ? '' : 's'}`;
  if (s.head.length === 0) return head;
  const more = s.count - s.head.length;
  return [
    head,
    s.head.map((m) => `- ${m}`).join('\n'),
    ...(more > 0 ? [`…and ${more.toLocaleString('en-US')} more`] : []),
  ].join('\n\n');
}

export async function expandZip(
  file: string,
  resume: ZipResume | null,
  budget: ExpandBudget,
): Promise<ExpandResult> {
  const state: ZipResume = resume
    ? { index: resume.index, count: resume.count, head: [...resume.head] }
    : { index: 0, count: 0, head: [] };
  const zf = await open(file);
  try {
    const t0 = Date.now();
    const items: ChildItem[] = [];
    let bytes = 0;
    for (let i = 0; ; i++) {
      // eslint-disable-next-line no-await-in-loop -- one entry at a time by design
      const e = await nextEntry(zf);
      if (!e) break;
      if (i < state.index || e.fileName.endsWith('/')) continue;
      state.index = i + 1;
      // eslint-disable-next-line no-await-in-loop
      const child = await memberChild(zf, e);
      if (child) {
        items.push(child);
        bytes += Buffer.byteLength(child.markdown ?? '');
        state.count += 1;
        if (state.head.length < HEAD_NAMES) state.head.push(e.fileName);
        if (state.count >= MAX_ZIP_CHILDREN)
          return { items, resume: null, summary: summary(file, state, true) };
      }
      if (
        items.length >= budget.items ||
        bytes >= budget.bytes ||
        Date.now() - t0 >= budget.ms
      )
        return { items, resume: { ...state } };
    }
    return { items, resume: null, summary: summary(file, state, false) };
  } finally {
    zf.close();
  }
}
