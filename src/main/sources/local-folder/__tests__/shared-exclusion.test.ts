/**
 * @jest-environment node
 *
 * Real walks and a real chokidar watcher: the shared folders are left to the
 * `shared-folder` source, also when a local-folder root such as ~/Documents
 * covers them.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { Account, Document, Session } from '@shared/contracts';

import { createLocalFolderSource } from '../local-folder-source';
import { isExcluded, walkPaths, walkRoot } from '../scanner';
import { startWatcher } from '../watch';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let dir: string;
let shared: string;
let parent: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-excl-'));
  parent = path.join(dir, 'Documents');
  shared = path.join(parent, 'Scans', 'Sorted');
  fs.mkdirSync(shared, { recursive: true });
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const write = (rel: string, text = 'text') => {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
  return abs;
};
const session = (signal = new AbortController().signal, watch = false): Session => {
  const account: Account = {
    id: 'acct-lf',
    source: 'local-folder',
    identifier: 'this-machine',
    config: { folderRoots: [{ id: parent, name: 'Documents' }], watch },
    status: 'connecting',
    cursor: null,
    createdAt: new Date().toISOString(),
  } as never;
  return { account, signal, credentials: async () => null, saveCredentials: async () => {}, log: () => {} };
};
const names = async (it: AsyncIterable<{ absPath: string }>) => {
  const out: string[] = [];
  for await (const e of it) out.push(path.relative(parent, e.absPath));
  return out.sort();
};

describe('isExcluded', () => {
  it('is true for a listed folder and anything under it, false for neighbours that share a prefix', () => {
    expect(isExcluded(shared, [shared])).toBe(true);
    expect(isExcluded(path.join(shared, 'a', 'b.txt'), [shared])).toBe(true);
    expect(isExcluded(`${shared} 2/a.txt`, [shared])).toBe(false);
    expect(isExcluded(path.join(parent, 'Scans', 'x.txt'), [shared])).toBe(false);
    expect(isExcluded(shared, [])).toBe(false);
    expect(isExcluded(shared, undefined)).toBe(false);
  });
});

describe('the walk', () => {
  it('does not descend into a shared subtree, while a sibling file still is listed', async () => {
    write('Documents/sibling.txt');
    write('Documents/Scans/Sorted/Tax/a.txt');
    write('Documents/Scans/Sorted/b.txt');
    write('Documents/Scans/other.txt');
    const opened: string[] = [];
    const real = fs.promises.opendir.bind(fs.promises);
    const spy = jest.spyOn(fs.promises, 'opendir').mockImplementation(((p: string, ...rest: unknown[]) => {
      opened.push(String(p));
      return (real as (...a: unknown[]) => Promise<fs.Dir>)(p, ...rest);
    }) as never);
    try {
      expect(await names(walkRoot(parent, undefined, [shared]))).toEqual(['Scans/other.txt', 'sibling.txt']);
    } finally {
      spy.mockRestore();
    }
    expect(opened.some((p) => p === shared || p.startsWith(`${shared}${path.sep}`))).toBe(false);
  });

  it('without an exclusion it lists everything (the control)', async () => {
    write('Documents/sibling.txt');
    write('Documents/Scans/Sorted/b.txt');
    expect(await names(walkRoot(parent))).toEqual(['Scans/Sorted/b.txt', 'sibling.txt']);
  });

  it('a root that is itself the shared folder, or inside it, lists nothing', async () => {
    write('Documents/Scans/Sorted/b.txt');
    write('Documents/Scans/Sorted/deep/c.txt');
    const out: string[] = [];
    for await (const p of walkPaths(shared, undefined, [shared])) out.push(p);
    for await (const p of walkPaths(path.join(shared, 'deep'), undefined, [shared])) out.push(p);
    expect(out).toEqual([]);
  });
});

describe('the source', () => {
  const source = (excluded?: () => string[]) =>
    createLocalFolderSource({
      converter: { expandPage: async () => ({ items: [], done: true }) } as never,
      excluded,
    });

  it('pull does not index the shared subtree', async () => {
    write('Documents/sibling.txt', 'sib');
    write('Documents/Scans/Sorted/Tax/a.txt', 'a');
    const src = source(() => [shared]);
    const ids: string[] = [];
    for await (const b of src.pull(session(), null))
      for (const i of b.items) ids.push(path.relative(parent, (i as { absPath: string }).absPath));
    expect(ids).toEqual(['sibling.txt']);
  });

  it('an incremental rescan (a cursor from before) does not pick up a changed file in the shared subtree', async () => {
    write('Documents/sibling.txt', 'sib');
    await sleep(150); // file times and the clock differ by a few ms
    const src = source(() => [shared]);
    let cursor: unknown = null;
    for await (const b of src.pull(session(), null)) cursor = b.cursor;
    await sleep(150);
    write('Documents/Scans/Sorted/new.txt', 'a'); // newer than the watermark
    write('Documents/sibling2.txt', 'b');
    const ids: string[] = [];
    for await (const b of src.pull(session(), cursor as never))
      for (const i of b.items) ids.push(path.relative(parent, (i as { absPath: string }).absPath));
    expect(ids).toEqual(['sibling2.txt']);
  });

  it('a live pull drops events from the shared subtree, while a sibling event comes through', async () => {
    write('Documents/sibling.txt', 'sib');
    const src = source(() => [shared]);
    const ac = new AbortController();
    const it = src.pull(session(ac.signal, true), null)[Symbol.asyncIterator]();
    const seen: string[] = [];
    try {
      for (;;) {
        // eslint-disable-next-line no-await-in-loop
        const r = await it.next();
        if (r.done) throw new Error('pull ended');
        if ((r.value.cursor as { policyVersion?: number }).policyVersion) break; // past the scan
      }
      await sleep(300);
      write('Documents/Scans/Sorted/live.txt', 'a');
      write('Documents/live-sibling.txt', 'b');
      const deadline = Date.now() + 5000;
      while (!seen.includes('live-sibling.txt') && Date.now() < deadline) {
        // eslint-disable-next-line no-await-in-loop
        const r = await Promise.race([it.next(), sleep(500).then(() => null)]);
        if (r && !r.done) for (const i of r.value.items) seen.push(path.relative(parent, (i as { absPath: string }).absPath));
      }
      await sleep(300);
    } finally {
      ac.abort();
      await it.return?.(undefined);
    }
    expect(seen).toContain('live-sibling.txt');
    expect(seen.some((x) => x.includes('live.txt'))).toBe(false);
  });

  it('reconcile does not list it, fetchBytes does not read it, a sibling still works', async () => {
    const sib = write('Documents/sibling.txt', 'sib');
    const inShared = write('Documents/Scans/Sorted/a.txt', 'a');
    const src = source(() => [shared]);
    const listed: string[] = [];
    for await (const page of src.reconcile!(session())) listed.push(...page.map((r) => r.externalId));
    expect(listed.map((l) => path.basename(l))).toEqual(['sibling.txt']);
    const doc = (abs: string) => ({ metadata: { absPath: abs } }) as unknown as Document;
    expect(Buffer.from((await src.fetchBytes!(session(), doc(sib)))!).toString()).toBe('sib');
    expect(await src.fetchBytes!(session(), doc(inShared))).toBeNull();
  });

  it('the provider is read each time: a folder shared later is left alone from then on', async () => {
    const inShared = write('Documents/Scans/Sorted/a.txt', 'a');
    let list: string[] = [];
    const src = source(() => list);
    const doc = { metadata: { absPath: inShared } } as unknown as Document;
    expect(await src.fetchBytes!(session(), doc)).not.toBeNull();
    list = [shared];
    expect(await src.fetchBytes!(session(), doc)).toBeNull();
  });
});

describe('the watcher', () => {
  it('does not report events under a shared subtree; a sibling still is', async () => {
    write('Documents/sibling.txt', 'x');
    const ac = new AbortController();
    const w = startWatcher([parent], ac.signal, undefined, () => [shared]);
    try {
      await sleep(400);
      write('Documents/Scans/Sorted/new.txt', 'a');
      write('Documents/sibling2.txt', 'b');
      await sleep(900);
      const seen: string[] = [];
      for (let e = w.take(); e; e = w.take()) seen.push(path.relative(parent, e.absPath));
      expect(seen).toContain('sibling2.txt');
      expect(seen.some((s) => s.startsWith(path.join('Scans', 'Sorted')))).toBe(false);
    } finally {
      ac.abort();
      await w.close();
    }
  });

  it('an event from a folder already being watched is dropped once it has become shared', async () => {
    write('Documents/Scans/Sorted/seed.txt', 'x');
    let list: string[] = [];
    const ac = new AbortController();
    const w = startWatcher([parent], ac.signal, undefined, () => list);
    try {
      await sleep(400); // chokidar now watches the Sorted folder
      list = [shared]; // it becomes shared meanwhile
      write('Documents/Scans/Sorted/late.txt', 'a');
      write('Documents/ok.txt', 'b');
      await sleep(900);
      const seen: string[] = [];
      for (let e = w.take(); e; e = w.take()) seen.push(path.relative(parent, e.absPath));
      expect(seen).toContain('ok.txt');
      expect(seen).not.toContain(path.join('Scans', 'Sorted', 'late.txt'));
    } finally {
      ac.abort();
      await w.close();
    }
  });
});
