/** ZIP → one `file` child per member (Takeout, WhatsApp, LinkedIn, Slack
 *  exports…), each routed by the SAME policy as a local file: text members
 *  are decoded, document members go through the converter's parsers, media
 *  and anything over the caps become name-only children. Random access via
 *  yauzl; only one member is inflated at a time and every read is counted.
 *  Pure (converter child). */
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import zlib from 'node:zlib';

import yauzl from 'yauzl';

import { decideFileIndexing } from '@shared/file-indexability';
import { resolvePathMime } from '@main/sources/local-folder/mime';

import { capMarkdown } from '../formats/limits';
import { parseDetailed } from '../parsers';
import { expandEnex } from './enex';
import { expandMbox } from './mbox';
import {
  containerKindOf,
  type ChildItem,
  type ContainerKind,
  type ExpandBudget,
  type ExpandResult,
} from './types';
import { expandVcard } from './vcard';

export const MAX_MEMBER_BYTES = 20 * 1024 * 1024;
export const MAX_ZIP_CHILDREN = 100_000;
/** The live cap (tests lower it). */
export const ZIP_LIMITS = { children: MAX_ZIP_CHILDREN };
const MAX_RATIO = 100;
const RATIO_FLOOR = 1024 * 1024;
const HEAD_NAMES = 50;

export interface ZipResume {
  /** Central-directory index of the next entry. */
  index: number;
  /** Byte offset of that entry's central-directory header: a resumed page
   *  starts there instead of re-reading every earlier header. */
  cd?: number;
  count: number;
  /** First member names, for the summary. */
  head: string[];
  /** Children emitted so far, nested items included — the cap's counter
   *  (`count` is members, for the "N files" line). Absent = `count`. */
  children?: number;
  /** `<member> — N messages` lines for expanded nested containers (first
   *  NESTED_LINES), and how many more there were. */
  nestedLines?: string[];
  nestedOmitted?: number;
  /** A mailbox/vCard/ENEX member being expanded. */
  nested?: NestedState;
}

export type NestedKind = Extract<ContainerKind, 'mbox' | 'vcard' | 'enex'>;

/** A nested container member. The pager never copies it: it stops the page
 *  and the SOURCE extracts it (`extractMember`, in main — a multi-GB copy
 *  would not fit a converter job), then sets `file` to the scratch copy
 *  before each later page. */
export interface NestedState {
  member: string;
  /** Central-directory index and header offset of the member's entry. */
  index: number;
  cd: number;
  size: number;
  crc32: number;
  mtime: string;
  kind: NestedKind;
  /** The inner pager's resume. */
  inner: unknown | null;
  items: number;
  /** Set by the source: the complete scratch copy to page. */
  file?: string;
  /** Set by the source: could not be extracted — name-only. */
  skip?: true;
}

const NESTED_LINES = 50;
const NOUN: Record<NestedKind, [string, string]> = {
  mbox: ['message', 'messages'],
  vcard: ['card', 'cards'],
  enex: ['note', 'notes'],
};

/** The scratch file name for a nested member: one per ENTRY (a zip may hold
 *  two members with the same name), derived — never persisted. */
export function scratchName(zipPath: string, n: NestedState): string {
  const h = createHash('sha1')
    .update(`${zipPath}\0${n.member}\0${n.cd}\0${n.crc32}`)
    .digest('hex');
  return `${h}.${n.kind}`;
}

const pageInner = (
  n: NestedState,
  budget: ExpandBudget,
): Promise<ExpandResult> => {
  const file = n.file as string;
  switch (n.kind) {
    case 'mbox':
      return expandMbox(file, n.inner as never, budget);
    case 'vcard':
      return expandVcard(file, n.inner as never, budget);
    default:
      return expandEnex(file, n.inner as never, budget);
  }
};

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

/** yauzl 2.10 keeps its central-directory walk in two instance fields
 *  (`readEntryCursor`, `entriesRead`) that only `_readEntry` consumes. Not
 *  public API: pinned by a test, with the skip scan as the fallback. */
interface WalkFields {
  readEntryCursor?: unknown;
  entriesRead?: unknown;
}

function seekTo(zf: yauzl.ZipFile, cd: number, index: number): boolean {
  const w = zf as unknown as WalkFields;
  if (
    typeof w.readEntryCursor !== 'number' ||
    typeof w.entriesRead !== 'number'
  )
    return false;
  w.readEntryCursor = cd;
  w.entriesRead = index;
  return true;
}

const cursorOf = (zf: yauzl.ZipFile): number | undefined => {
  const c = (zf as unknown as WalkFields).readEntryCursor;
  return typeof c === 'number' ? c : undefined;
};

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

function nameOnly(member: string, size: number, mtime: string): ChildItem {
  const filename = path.posix.basename(member);
  const dot = filename.lastIndexOf('.');
  return {
    key: `zip:${member}`,
    type: 'file',
    title: filename,
    markdown: null,
    metadata: {
      member,
      filename,
      mime: resolvePathMime(member),
      ext: dot > 0 ? filename.slice(dot + 1).toLowerCase() : '',
      sizeBytes: size,
      mtime,
    },
    createdAt: null,
  };
}

const encrypted = (e: yauzl.Entry) => (e.generalPurposeBitFlag & 0x1) !== 0;
const bomb = (e: yauzl.Entry) =>
  e.uncompressedSize > RATIO_FLOOR &&
  e.uncompressedSize > e.compressedSize * MAX_RATIO;

/** The kind of a member the pager expands in place (mailbox, vCard, ENEX),
 *  or null — nested ZIP/PST and unsafe members stay name-only. */
function nestedKindOf(e: yauzl.Entry): NestedKind | null {
  if (encrypted(e) || bomb(e)) return null;
  const member = e.fileName;
  const kind = containerKindOf(
    path.posix.basename(member),
    resolvePathMime(member),
  );
  return kind === 'mbox' || kind === 'vcard' || kind === 'enex' ? kind : null;
}

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
  const child = nameOnly(
    member,
    e.uncompressedSize,
    e.getLastModDate().toISOString(),
  );
  const readable =
    decision.bytes === 'eager' &&
    (decision.pipeline === 'inline-text' || decision.pipeline === 'converter');
  if (
    encrypted(e) ||
    bomb(e) ||
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
  const parts = [head];
  const lines = s.nestedLines ?? [];
  if (lines.length > 0) {
    const omitted = s.nestedOmitted ?? 0;
    parts.push(
      [
        ...lines,
        ...(omitted > 0
          ? [`…and ${omitted.toLocaleString('en-US')} more`]
          : []),
      ].join('\n'),
    );
  }
  if (s.head.length > 0) {
    const more = s.count - s.head.length;
    parts.push(
      s.head.map((m) => `- ${m}`).join('\n'),
      ...(more > 0 ? [`…and ${more.toLocaleString('en-US')} more`] : []),
    );
  }
  return parts.join('\n\n');
}

/** A nested member is done (expanded or name-only): counts as one file. */
function finishNested(
  state: ZipResume,
  n: NestedState,
  expanded: boolean,
): void {
  state.count += 1;
  if (state.head.length < HEAD_NAMES) state.head.push(n.member);
  if (expanded) {
    const [one, many] = NOUN[n.kind];
    const line = `- ${n.member} — ${n.items.toLocaleString('en-US')} ${n.items === 1 ? one : many}`;
    state.nestedLines ??= [];
    const lines = state.nestedLines;
    if (lines.length < NESTED_LINES) lines.push(line);
    else state.nestedOmitted = (state.nestedOmitted ?? 0) + 1;
  }
  delete state.nested;
}

export async function expandZip(
  file: string,
  resume: ZipResume | null,
  budget: ExpandBudget,
): Promise<ExpandResult> {
  const state: ZipResume = resume
    ? {
        ...resume,
        head: [...resume.head],
        children: resume.children ?? resume.count,
        ...(resume.nestedLines ? { nestedLines: [...resume.nestedLines] } : {}),
        ...(resume.nested ? { nested: { ...resume.nested } } : {}),
      }
    : { index: 0, count: 0, head: [], children: 0 };
  const t0 = Date.now();
  const items: ChildItem[] = [];
  let bytes = 0;
  const spent = () =>
    items.length >= budget.items ||
    bytes >= budget.bytes ||
    Date.now() - t0 >= budget.ms;
  const children = () => state.children ?? 0;
  const capped = () => children() >= ZIP_LIMITS.children;
  const add = (c: ChildItem) => {
    items.push(c);
    bytes += Buffer.byteLength(c.markdown ?? '');
    state.children = children() + 1;
  };

  // 1. A nested member in progress.
  const n = state.nested;
  if (n) {
    if (n.skip) {
      add(nameOnly(n.member, n.size, n.mtime));
      finishNested(state, n, false);
    } else if (n.file && fs.existsSync(n.file)) {
      const r = await pageInner(n, {
        items: Math.max(
          1,
          Math.min(
            budget.items - items.length,
            ZIP_LIMITS.children - children(),
          ),
        ),
        bytes: budget.bytes - bytes,
        ms: budget.ms - (Date.now() - t0),
      });
      // A fresh copy never appends, so the inner pager cannot ask for a
      // restart; its tail and summary are the member's, not the ZIP's.
      for (const c of r.items) {
        add({ ...c, key: `zip:${n.member}#${c.key}` });
        n.items += 1;
      }
      if (r.resume === null) finishNested(state, n, true);
      else {
        n.inner = r.resume;
        delete n.file;
        if (capped())
          return { items, resume: null, summary: summary(file, state, true) };
        return { items, resume: state };
      }
    } else {
      // Waiting for the source to extract the member.
      delete n.file;
      return { items, resume: state };
    }
    if (capped())
      return { items, resume: null, summary: summary(file, state, true) };
    if (spent()) return { items, resume: state };
  }

  // 2. The walk.
  const zf = await open(file);
  const start =
    state.cd !== undefined && seekTo(zf, state.cd, state.index)
      ? state.index
      : 0;
  try {
    for (let i = start; ; i++) {
      const here = cursorOf(zf); // this entry's header offset
      // eslint-disable-next-line no-await-in-loop -- one entry at a time by design
      const e = await nextEntry(zf);
      if (!e) break;
      if (i < state.index) continue; // the fallback skip scan
      state.index = i + 1;
      const cd = cursorOf(zf);
      if (cd !== undefined) state.cd = cd;
      if (e.fileName.endsWith('/')) continue;
      const kind = here !== undefined ? nestedKindOf(e) : null;
      if (kind && here !== undefined) {
        // Stop the page here: the source extracts the member, and the next
        // pages expand it.
        state.nested = {
          member: e.fileName,
          index: i,
          cd: here,
          size: e.uncompressedSize,
          crc32: e.crc32,
          mtime: e.getLastModDate().toISOString(),
          kind,
          inner: null,
          items: 0,
        };
        return { items, resume: state };
      }
      // eslint-disable-next-line no-await-in-loop
      const child = await memberChild(zf, e);
      if (child) {
        add(child);
        state.count += 1;
        if (state.head.length < HEAD_NAMES) state.head.push(e.fileName);
        if (capped())
          return { items, resume: null, summary: summary(file, state, true) };
      }
      if (spent()) return { items, resume: state };
    }
    return { items, resume: null, summary: summary(file, state, false) };
  } finally {
    zf.close();
  }
}

export type ExtractOutcome = 'ok' | 'nospace' | 'corrupt' | 'mismatch';

/** The member's raw (still compressed) bytes, read straight from the file:
 *  yauzl's own streams do not settle on destroy, so the copy owns every
 *  stream in its pipeline. */
async function rawRange(
  zipPath: string,
  e: yauzl.Entry,
): Promise<{ start: number; length: number }> {
  const fh = await fs.promises.open(zipPath, 'r');
  try {
    const h = Buffer.alloc(30);
    const { bytesRead } = await fh.read(
      h,
      0,
      30,
      e.relativeOffsetOfLocalHeader,
    );
    if (bytesRead !== 30 || h.readUInt32LE(0) !== 0x04034b50)
      throw new Error('zip: bad local file header');
    const start =
      e.relativeOffsetOfLocalHeader +
      30 +
      h.readUInt16LE(26) +
      h.readUInt16LE(28);
    return { start, length: e.compressedSize };
  } finally {
    await fh.close();
  }
}

/**
 * Copies a nested member to `dest` (via `dest.part`, renamed when complete
 * and verified). Runs in MAIN (the local-folder source), not the converter
 * child. Integrity is the declared size AND CRC-32 — a forged size never
 * yields a silently truncated mailbox. Throws on abort and I/O errors.
 */
export async function extractMember(
  zipPath: string,
  n: NestedState,
  dest: string,
  opts: { signal?: AbortSignal } = {},
): Promise<ExtractOutcome> {
  const zf = await open(zipPath);
  let e: yauzl.Entry | null = null;
  try {
    if (seekTo(zf, n.cd, n.index)) e = await nextEntry(zf);
    else
      for (let i = 0; i <= n.index; i++) {
        // eslint-disable-next-line no-await-in-loop
        e = await nextEntry(zf);
        if (!e) break;
      }
  } catch {
    e = null;
  } finally {
    zf.close();
  }
  if (
    !e ||
    e.fileName !== n.member ||
    e.uncompressedSize !== n.size ||
    e.crc32 !== n.crc32
  )
    return 'mismatch';
  if (e.compressionMethod !== 0 && e.compressionMethod !== 8) return 'corrupt';

  const fsStat = await fs.promises.statfs(path.dirname(dest));
  // Sound only because the copy is capped at exactly the declared size.
  if (fsStat.bavail * fsStat.bsize < 2 * n.size) return 'nospace';

  const { start, length } = await rawRange(zipPath, e);
  const part = `${dest}.part`;
  let count = 0;
  let crc = 0;
  let over = false;
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      count += chunk.length;
      if (count > n.size) {
        over = true;
        cb(new Error('zip: member inflates past its declared size'));
        return;
      }
      crc = zlib.crc32(chunk, crc);
      cb(null, chunk);
    },
  });
  const source =
    length > 0
      ? fs.createReadStream(zipPath, { start, end: start + length - 1 })
      : Readable.from([]);
  try {
    await pipeline(
      [
        source,
        ...(e.compressionMethod === 8 ? [zlib.createInflateRaw()] : []),
        counter,
        fs.createWriteStream(part),
      ],
      { signal: opts.signal },
    );
  } catch (err) {
    await fs.promises.rm(part, { force: true });
    if (opts.signal?.aborted) throw err;
    if (over) return 'corrupt';
    if ((err as NodeJS.ErrnoException).code === 'ENOSPC') return 'nospace';
    if (String((err as NodeJS.ErrnoException).code ?? '').startsWith('Z_'))
      return 'corrupt';
    throw err;
  }
  if (count !== n.size || crc >>> 0 !== n.crc32 >>> 0) {
    await fs.promises.rm(part, { force: true });
    return 'corrupt';
  }
  await fs.promises.rename(part, dest);
  return 'ok';
}
