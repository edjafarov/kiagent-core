import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { DocumentInput } from '@shared/contracts';

import { ConverterUnavailableError } from '../../../core/converter/converter';
import {
  EXPANDER_VERSION,
  type ChildItem,
  type ExpandResult,
} from '../../../core/converter/containers/types';
import type { Expansion, PendingExpansion } from '../cursor';
import {
  EXPANSION_RETRY_MS,
  expansionStep,
  nextDue,
  nextPending,
  noteContainer,
} from '../expansion';
import { toAbsPosix } from '../scanner';
import type { LocalFolderItem } from '../to-document';

const at = { size: 100, mtimeMs: 1_000 };

describe('noteContainer', () => {
  it('starts a full path for a new container', () => {
    expect(noteContainer(undefined, 'zip', at)).toEqual({
      state: 'pending',
      kind: 'zip',
      v: EXPANDER_VERSION.zip,
      ...at,
      resume: null,
      cleared: false,
      attempts: 0,
    });
  });

  it('keeps a done zip until size or mtime moves', () => {
    const done: Expansion = {
      state: 'done',
      kind: 'zip',
      v: EXPANDER_VERSION.zip,
      ...at,
    };
    expect(noteContainer(done, 'zip', at)).toBe(done);
    expect(noteContainer(done, 'zip', { ...at, mtimeMs: 2_000 })).toMatchObject(
      { state: 'pending', resume: null, cleared: false },
    );
  });

  it('ignores an mbox mtime change (Thunderbird flag rewrite)', () => {
    const done: Expansion = { state: 'done', kind: 'mbox', v: 1, ...at };
    expect(noteContainer(done, 'mbox', { ...at, mtimeMs: 9_999 })).toBe(done);
  });

  it('resumes a grown mbox from its tail without clearing', () => {
    const tail = { offset: 100, count: 3, append: true };
    const done: Expansion = { state: 'done', kind: 'mbox', v: 1, ...at, tail };
    expect(noteContainer(done, 'mbox', { size: 150, mtimeMs: 2 })).toEqual({
      state: 'pending',
      kind: 'mbox',
      v: 1,
      size: 150,
      mtimeMs: 2,
      resume: tail,
      cleared: true,
      attempts: 0,
    });
  });

  it('full-paths a shrunk mbox', () => {
    const done: Expansion = {
      state: 'done',
      kind: 'mbox',
      v: 1,
      ...at,
      tail: { offset: 100 },
    };
    expect(noteContainer(done, 'mbox', { size: 50, mtimeMs: 2 })).toMatchObject(
      { state: 'pending', resume: null, cleared: false },
    );
  });

  it('keeps reading an mbox that grows mid-expansion', () => {
    const pending: PendingExpansion = {
      state: 'pending',
      kind: 'mbox',
      v: 1,
      ...at,
      resume: { offset: 40 },
      cleared: true,
      attempts: 1,
    };
    expect(noteContainer(pending, 'mbox', { size: 200, mtimeMs: 5 })).toEqual({
      ...pending,
      size: 200,
      mtimeMs: 5,
    });
  });

  it('restarts a pending zip that changed', () => {
    const pending: PendingExpansion = {
      state: 'pending',
      kind: 'zip',
      v: 1,
      ...at,
      resume: { index: 4 },
      cleared: true,
      attempts: 0,
    };
    expect(
      noteContainer(pending, 'zip', { size: 101, mtimeMs: 1_000 }),
    ).toMatchObject({ resume: null, cleared: false, size: 101 });
  });

  it('re-expands done and failed records of an older expander version', () => {
    const old: Expansion = { state: 'failed', kind: 'vcard', v: 0, ...at };
    expect(noteContainer(old, 'vcard', at)).toMatchObject({
      state: 'pending',
      v: EXPANDER_VERSION.vcard,
    });
  });

  it('restarts a pending record left by an older expander version', () => {
    const old: PendingExpansion = {
      state: 'pending',
      kind: 'zip',
      v: 0,
      ...at,
      resume: { index: 7 },
      cleared: true,
      attempts: 0,
    };
    expect(noteContainer(old, 'zip', at)).toMatchObject({
      resume: null,
      cleared: false,
      v: EXPANDER_VERSION.zip,
    });
  });

  it('keeps a failed record until the file changes', () => {
    const failed: Expansion = { state: 'failed', kind: 'enex', v: 1, ...at };
    expect(noteContainer(failed, 'enex', at)).toBe(failed);
  });
});

describe('nextPending / nextDue', () => {
  const p = (extra: Partial<PendingExpansion> = {}): PendingExpansion => ({
    state: 'pending',
    kind: 'zip',
    v: 1,
    ...at,
    resume: null,
    cleared: false,
    attempts: 0,
    ...extra,
  });
  it('picks the oldest due pending record', () => {
    const exps: Record<string, Expansion> = {
      a: { state: 'done', kind: 'zip', v: EXPANDER_VERSION.zip, ...at },
      b: p({ notBefore: 500 }),
      c: p(),
    };
    expect(nextPending(exps, 100)).toBe('c');
    expect(nextPending(exps, 500)).toBe('b');
    expect(nextDue(exps)).toBe(500);
    expect(nextPending({ a: exps.a }, 0)).toBeNull();
    expect(nextDue({ c: p() })).toBeNull();
  });
});

describe('expansionStep', () => {
  let dir: string;
  let file: string;
  let id: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kia-exp-'));
    file = path.join(dir, 'inbox.mbox');
    fs.writeFileSync(file, 'x'.repeat(10));
    id = toAbsPosix(file);
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const rec = (extra: Partial<PendingExpansion> = {}): PendingExpansion => ({
    state: 'pending',
    kind: 'mbox',
    v: 1,
    size: 10,
    mtimeMs: 7,
    resume: null,
    cleared: true,
    attempts: 0,
    ...extra,
  });
  const child = (key: string): ChildItem => ({
    key,
    type: 'email.message',
    title: `msg ${key}`,
    markdown: `# ${key}`,
    metadata: { from: 'a@b.c' },
    createdAt: '2026-01-01T00:00:00.000Z',
  });
  const conv = (impl: () => Promise<ExpandResult>) => ({
    expandPage: jest.fn(impl),
  });
  const docs = (items: LocalFolderItem[]) =>
    items.map((i) => ('prebuilt' in i ? i.prebuilt : null) as DocumentInput);

  it('drops the record and deletes the container when the file is gone', async () => {
    fs.rmSync(file);
    const converter = conv(async () => ({ items: [], resume: null }));
    const out = await expansionStep({
      absPath: file,
      rec: rec(),
      converter,
      now: 0,
    });
    expect(out).toEqual({
      items: [],
      deletions: [{ externalId: id, type: 'file' }],
      rec: null,
    });
    expect(converter.expandPage).not.toHaveBeenCalled();
  });

  it('treats a container swapped for a symlink as gone, never followed', async () => {
    const target = path.join(dir, 'elsewhere.mbox');
    fs.renameSync(file, target);
    fs.symlinkSync(target, file);
    const converter = conv(async () => ({ items: [], resume: null }));
    const out = await expansionStep({
      absPath: file,
      rec: rec(),
      converter,
      now: 0,
    });
    expect(out).toEqual({
      items: [],
      deletions: [{ externalId: id, type: 'file' }],
      rec: null,
    });
    expect(converter.expandPage).not.toHaveBeenCalled();
  });

  it('starts a full path with a deletions-only batch', async () => {
    const converter = conv(async () => ({ items: [], resume: null }));
    const out = await expansionStep({
      absPath: file,
      rec: rec({ cleared: false }),
      converter,
      now: 0,
    });
    expect(out.items).toEqual([]);
    expect(out.deletions).toEqual([{ externalId: id, type: 'file' }]);
    expect(out.rec).toMatchObject({
      state: 'pending',
      cleared: true,
      resume: null,
    });
    expect(converter.expandPage).not.toHaveBeenCalled();
  });

  it('emits a placeholder row then children on the first of several pages', async () => {
    const { signal } = new AbortController();
    const converter = conv(async () => ({
      items: [child('k1'), child('k2')],
      resume: { offset: 5 },
    }));
    const out = await expansionStep({
      absPath: file,
      rec: rec({ attempts: 2, notBefore: 1 }),
      scopeRootId: 'root-1',
      converter,
      signal,
      now: 0,
    });
    expect(converter.expandPage).toHaveBeenCalledWith(
      file,
      'mbox',
      null,
      expect.objectContaining({ items: expect.any(Number) }),
      signal,
    );
    const [row, c1, c2] = docs(out.items);
    expect(row).toMatchObject({
      externalId: id,
      type: 'file',
      markdown: '# inbox.mbox\n\nReading…',
      scopeRootId: 'root-1',
      metadata: expect.objectContaining({ conversion: { status: 'ok' } }),
    });
    expect(c1).toEqual({
      externalId: `${id}#k1`,
      type: 'email.message',
      title: 'msg k1',
      markdown: '# k1',
      metadata: {
        from: 'a@b.c',
        conversion: { status: 'ok' },
        extraction: { container: 'mbox' },
      },
      createdAt: '2026-01-01T00:00:00.000Z',
      parent: { externalId: id, type: 'file' },
      scopeRootId: 'root-1',
    });
    expect(c2).toMatchObject({ externalId: `${id}#k2` });
    expect(out.rec).toEqual({
      ...rec(),
      resume: { offset: 5 },
      attempts: 0,
    });
  });

  it('writes the summary row on the last page and records the tail', async () => {
    const converter = conv(async () => ({
      items: [child('k3')],
      resume: null,
      summary: '# inbox.mbox — 3 messages',
      tail: { offset: 10, count: 3, append: true },
    }));
    const out = await expansionStep({
      absPath: file,
      rec: rec({ resume: { offset: 5 } }),
      converter,
      now: 0,
    });
    const [row, c3] = docs(out.items);
    expect(row).toMatchObject({
      externalId: id,
      markdown: '# inbox.mbox — 3 messages',
    });
    expect(c3).toMatchObject({ externalId: `${id}#k3` });
    expect(out.rec).toEqual({
      state: 'done',
      kind: 'mbox',
      v: 1,
      size: 10,
      mtimeMs: 7,
      tail: { offset: 10, count: 3, append: true },
    });
  });

  it('middle pages carry children only', async () => {
    const converter = conv(async () => ({
      items: [child('k9')],
      resume: { offset: 9 },
    }));
    const out = await expansionStep({
      absPath: file,
      rec: rec({ resume: { offset: 5 } }),
      converter,
      now: 0,
    });
    expect(docs(out.items).map((d) => d.externalId)).toEqual([`${id}#k9`]);
  });

  it('falls back to the full path on restart', async () => {
    const converter = conv(async () => ({
      items: [],
      resume: null,
      restart: true,
    }));
    const out = await expansionStep({
      absPath: file,
      rec: rec({ resume: { offset: 5, append: true } }),
      converter,
      now: 0,
    });
    expect(out.items).toEqual([]);
    expect(out.rec).toMatchObject({
      state: 'pending',
      resume: null,
      cleared: false,
    });
  });

  it('defers without an attempt while the converter is unavailable', async () => {
    const converter = conv(async () => {
      throw new ConverterUnavailableError('down');
    });
    const out = await expansionStep({
      absPath: file,
      rec: rec(),
      converter,
      now: 1_000,
    });
    expect(out.rec).toMatchObject({
      attempts: 0,
      notBefore: 1_000 + EXPANSION_RETRY_MS,
    });
  });

  it('leaves the record untouched on abort', async () => {
    const ac = new AbortController();
    const r = rec({ resume: { offset: 5 } });
    const converter = conv(async () => {
      ac.abort();
      throw new Error('aborted');
    });
    const out = await expansionStep({
      absPath: file,
      rec: r,
      converter,
      signal: ac.signal,
      now: 0,
    });
    expect(out).toEqual({ items: [], deletions: [], rec: r });
  });

  it('counts failures and marks the container failed at the third', async () => {
    const converter = conv(async () => {
      throw new Error('boom');
    });
    const one = await expansionStep({
      absPath: file,
      rec: rec(),
      converter,
      now: 0,
    });
    expect(one.rec).toMatchObject({
      attempts: 1,
      notBefore: EXPANSION_RETRY_MS,
    });
    expect(one.items).toEqual([]);
    const three = await expansionStep({
      absPath: file,
      rec: rec({ attempts: 2 }),
      converter,
      now: 0,
    });
    expect(three.rec).toEqual({
      state: 'failed',
      kind: 'mbox',
      v: 1,
      size: 10,
      mtimeMs: 7,
    });
    expect(docs(three.items)).toEqual([
      expect.objectContaining({
        externalId: id,
        markdown: '# inbox.mbox\n\nCould not read this file.',
      }),
    ]);
  });
});
