import fs from 'fs';
import os from 'os';
import path from 'path';

import type { Batch, Document, DocumentInput, Session } from '@shared/contracts';

import {
  closeDevices,
  device,
  withRoots,
  type Device,
} from '../../../core/shared-folders/__tests__/helpers/device';
import { copyRows, sha } from '../../../core/shared-folders/__tests__/helpers/fake-transport';
import { createSharedFolderSource, type SharedFolderCursor } from '../shared-folder-source';
import type { SharedFileItem } from '../to-document';

afterEach(closeDevices);

const write = (file: string, text: string, mtime = new Date('2026-03-04T05:06:07Z')) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  fs.utimesSync(file, mtime, mtime);
};
const scan = async (d: Device) => {
  d.svc.kick();
  await d.svc.settled();
};
const hostOf = (d: Device) => ({ db: d.db, sharedFolders: d.svc });
const session = (signal = new AbortController().signal, watch = false): Session => ({
  account: { id: 'acct-shared', source: 'shared-folder', identifier: 'shared', config: watch ? {} : { watch: false } } as never,
  signal,
  credentials: async () => null,
  saveCredentials: async () => {},
  log: () => {},
});

async function pullAll(d: Device, cursor: SharedFolderCursor | null = null) {
  const source = createSharedFolderSource(() => hostOf(d));
  const batches: Batch<SharedFolderCursor, SharedFileItem>[] = [];
  for await (const b of source.pull(session(), cursor)) batches.push(b);
  const docs = batches.flatMap((b) => b.items).map((i) => source.toDocument(i) as DocumentInput);
  const deletions = batches.flatMap((b) => b.deletions ?? []);
  return { source, batches, docs, deletions, cursor: batches[batches.length - 1]?.cursor ?? cursor };
}
async function leader() {
  const d = await device('leader');
  const roots = await withRoots(d);
  await d.svc.settled();
  return { d, ...roots };
}
const ids = (docs: DocumentInput[]) => docs.map((x) => x.externalId).sort();

it('a file becomes one document with a root-and-path identity, no absolute path, no link', async () => {
  const { d, sorted } = await leader();
  write(path.join(sorted, 'tax', 'a.txt'), 'hello world');
  await scan(d);
  const { docs } = await pullAll(d);
  expect(docs).toHaveLength(1);
  const doc = docs[0];
  expect(doc).toMatchObject({
    externalId: 'sorted/tax/a.txt',
    type: 'file',
    title: 'a.txt',
    markdown: 'hello world',
    metadata: {
      root: 'sorted',
      relPath: 'tax/a.txt',
      sha256: sha('hello world'),
      sizeBytes: 11,
      ext: 'txt',
      filename: 'a.txt',
    },
  });
  expect(doc.metadata).not.toHaveProperty('absPath');
  expect(doc).not.toHaveProperty('url');
  expect(doc).not.toHaveProperty('scopeRootId');
  expect(JSON.stringify(doc)).not.toContain(d.dir);
});

it('two Macs with different absolute roots produce the same document for the same row', async () => {
  const { d: lead, sorted } = await leader();
  write(path.join(sorted, 'tax', 'a.txt'), 'hello world');
  write(path.join(sorted, 'b.txt'), 'second');
  await scan(lead);
  const copy = await device('copy');
  const mine = await withRoots(copy);
  write(path.join(mine.sorted, 'tax', 'a.txt'), 'hello world');
  write(path.join(mine.sorted, 'b.txt'), 'second');
  await copyRows(lead.db, copy.db);
  copy.sync.set('leader'); // the source runs on a leader, after its reconcile
  await copy.svc.settled();
  const a = await pullAll(lead);
  const b = await pullAll(copy);
  expect(a.docs.map((x) => ({ ...x, createdAt: undefined }))).toEqual(b.docs.map((x) => ({ ...x, createdAt: undefined })));
  expect(lead.dir).not.toBe(copy.dir);
});

it('a deleted row archives its document; a missing_here row neither emits nor deletes', async () => {
  const { d, sorted } = await leader();
  write(path.join(sorted, 'gone.txt'), 'x');
  write(path.join(sorted, 'keep.txt'), 'k');
  await scan(d);
  fs.rmSync(path.join(sorted, 'gone.txt'));
  await scan(d);
  await d.db.run(
    `INSERT INTO shared_files(root, rel_path, sha256, bytes, mtime, missing_here, deleted, parked, rev)
     VALUES('sorted','away.txt',?,3,'t',1,0,0,500)`,
    [sha('abc')],
  );
  const { docs, deletions, source } = await pullAll(d);
  expect(ids(docs)).toEqual(['sorted/keep.txt']);
  expect(deletions).toEqual([{ externalId: 'sorted/gone.txt', type: 'file' }]);
  const listed: string[] = [];
  for await (const page of source.reconcile!(session())) listed.push(...page.map((r) => r.externalId));
  expect(listed.sort()).toEqual(['sorted/away.txt', 'sorted/keep.txt']); // the missing_here row keeps its document
});

it('a file moved from Incoming to Sorted ends as one live document', async () => {
  const { d, incoming, sorted } = await leader();
  write(path.join(incoming, 'scan.txt'), 'scan text');
  write(path.join(incoming, 'other.txt'), 'other');
  await scan(d);
  const first = await pullAll(d);
  const live = new Map(first.docs.map((x) => [x.externalId, x]));
  fs.mkdirSync(path.join(sorted, 'Tax'));
  fs.renameSync(path.join(incoming, 'scan.txt'), path.join(sorted, 'Tax', 'scan.txt'));
  await scan(d);
  const second = await pullAll(d, first.cursor);
  for (const x of second.docs) live.set(x.externalId, x);
  for (const r of second.deletions) live.delete(r.externalId);
  expect([...live.keys()].sort()).toEqual(['incoming/other.txt', 'sorted/Tax/scan.txt']);
});

it('the cursor makes the next pull incremental, and an edit is emitted again', async () => {
  const { d, sorted } = await leader();
  write(path.join(sorted, 'a.txt'), 'one');
  write(path.join(sorted, 'b.txt'), 'two');
  await scan(d);
  const first = await pullAll(d);
  expect(first.docs).toHaveLength(2);
  const idle = await pullAll(d, first.cursor);
  expect(idle.docs).toEqual([]);
  expect(idle.deletions).toEqual([]);
  write(path.join(sorted, 'a.txt'), 'one, edited');
  await scan(d);
  const next = await pullAll(d, first.cursor);
  expect(ids(next.docs)).toEqual(['sorted/a.txt']);
  expect(next.docs[0].markdown).toBe('one, edited');
});

it('a root that was not set when rows passed is listed again once it is', async () => {
  const { d, incoming, sorted } = await leader();
  write(path.join(incoming, 'in.txt'), 'in');
  write(path.join(sorted, 'out.txt'), 'out');
  await scan(d);
  await d.svc.setRoots({ incoming: null, sorted });
  await d.svc.settled();
  const first = await pullAll(d);
  expect(ids(first.docs)).toEqual(['sorted/out.txt']);
  await d.svc.setRoots({ incoming, sorted });
  await d.svc.settled();
  const second = await pullAll(d, first.cursor);
  expect(ids(second.docs)).toEqual(['incoming/in.txt', 'sorted/out.txt']);
});

it('a file that changed since the scan is not parsed until the scan has listed the change; then the hash is of the bytes parsed', async () => {
  const { d, sorted } = await leader();
  write(path.join(sorted, 'a.txt'), 'scanned text');
  await scan(d);
  const first = await pullAll(d);
  write(path.join(sorted, 'a.txt'), 'changed after the scan!');
  expect((await pullAll(d, first.cursor)).docs).toEqual([]); // the row still names the old bytes
  await scan(d);
  const { docs } = await pullAll(d, first.cursor);
  expect(docs[0].markdown).toBe('changed after the scan!');
  expect(docs[0].metadata?.sha256).toBe(sha('changed after the scan!'));
});

it('a live row whose file is not here is skipped, not deleted', async () => {
  const { d, sorted } = await leader();
  write(path.join(sorted, 'a.txt'), 'one');
  write(path.join(sorted, 'b.txt'), 'two');
  await scan(d);
  fs.rmSync(path.join(sorted, 'a.txt')); // scan has not noticed yet
  const { docs, deletions } = await pullAll(d);
  expect(ids(docs)).toEqual(['sorted/b.txt']);
  expect(deletions).toEqual([]);
});

it('a missing_here row emits nothing even though an older version of the file is on this disk', async () => {
  const { d, sorted } = await leader();
  write(path.join(sorted, 'a.txt'), 'older version');
  write(path.join(sorted, 'b.txt'), 'other');
  await scan(d);
  await d.db.run(`UPDATE shared_files SET sha256 = ?, missing_here = 1, rev = 900 WHERE rel_path = 'a.txt'`, [sha('newer')]);
  const { docs, deletions } = await pullAll(d);
  expect(ids(docs)).toEqual(['sorted/b.txt']);
  expect(deletions).toEqual([]);
});

it('a file that changes while it is read is not emitted from mixed bytes; the scan lists the change', async () => {
  const { d, sorted } = await leader();
  const file = path.join(sorted, 'a.txt');
  write(file, 'first version');
  write(path.join(sorted, 'b.txt'), 'other');
  await scan(d);
  const real = fs.promises.readFile.bind(fs.promises);
  const spy = jest.spyOn(fs.promises, 'readFile').mockImplementation((async (...args: unknown[]) => {
    const out = await (real as (...a: unknown[]) => Promise<unknown>)(...args);
    if (String(args[0]) === file) fs.writeFileSync(file, 'second version, longer');
    return out;
  }) as never);
  try {
    const { docs, deletions } = await pullAll(d);
    expect(ids(docs)).toEqual(['sorted/b.txt']);
    expect(deletions).toEqual([]);
  } finally {
    spy.mockRestore();
  }
  await scan(d);
  expect(ids((await pullAll(d)).docs)).toEqual(['sorted/a.txt', 'sorted/b.txt']);
});

it('an archive or mailbox is findable by name, not expanded', async () => {
  const { d, sorted } = await leader();
  write(path.join(sorted, 'bundle.zip'), 'PK not really');
  await scan(d);
  const { docs } = await pullAll(d);
  expect(docs).toHaveLength(1);
  expect(docs[0]).toMatchObject({ externalId: 'sorted/bundle.zip', type: 'file' });
  expect(docs[0].markdown ?? null).toBeNull();
  expect(docs[0].metadata).toMatchObject({ root: 'sorted', relPath: 'bundle.zip' });
});

it('reconcile lists every row that is not deleted, in pages', async () => {
  const { d } = await leader();
  const steps = [];
  for (let i = 0; i < 1100; i += 1)
    steps.push({
      sql: `INSERT INTO shared_files(root, rel_path, sha256, bytes, mtime, missing_here, deleted, parked, rev)
            VALUES('sorted', ?, 'h', 1, 't', ?, ?, 0, ?)`,
      params: [`f${String(i).padStart(4, '0')}.txt`, i % 10 === 0 ? 1 : 0, i % 7 === 0 ? 1 : 0, i + 1],
    });
  await d.db.batch(steps);
  const source = createSharedFolderSource(() => hostOf(d));
  const pages: string[][] = [];
  for await (const page of source.reconcile!(session())) pages.push(page.map((r) => r.externalId));
  const all = pages.flat();
  expect(pages.length).toBeGreaterThan(1);
  expect(new Set(all).size).toBe(all.length);
  expect(all).toHaveLength(1100 - Math.ceil(1100 / 7));
  expect(all).not.toContain('sorted/f0000.txt');
  expect(all).toContain('sorted/f0010.txt'); // missing_here, not deleted
});

describe('fetchBytes', () => {
  const doc = (externalId: string): Document => ({ accountId: 'acct-shared', externalId } as never);
  const addAccount = (d: Device) =>
    d.db.run(
      `INSERT INTO accounts(id, source, identifier, config, status, created_at)
       VALUES('acct-shared', 'shared-folder', 'shared', '{}', 'connecting', 'now')`,
    );

  it('reads the file at this Mac\'s own path for the document', async () => {
    const { d, sorted } = await leader();
    await addAccount(d);
    write(path.join(sorted, 'tax', 'a.txt'), 'hello');
    await scan(d);
    const source = createSharedFolderSource(() => hostOf(d));
    const bytes = await source.fetchBytes!(session(), doc('sorted/tax/a.txt'));
    expect(Buffer.from(bytes!).toString()).toBe('hello');
  });

  it('is null for a missing file, an unset root, another account and a hostile id', async () => {
    const { d, sorted } = await leader();
    await addAccount(d);
    write(path.join(sorted, 'a.txt'), 'hello');
    const source = createSharedFolderSource(() => hostOf(d));
    expect(await source.fetchBytes!(session(), doc('sorted/none.txt'))).toBeNull();
    expect(await source.fetchBytes!(session(), doc('sorted/../a.txt'))).toBeNull();
    expect(await source.fetchBytes!(session(), doc('elsewhere/a.txt'))).toBeNull();
    expect(await source.fetchBytes!(session(), { accountId: 'other', externalId: 'sorted/a.txt' } as never)).toBeNull();
    await d.svc.setRoots({ incoming: null, sorted: null });
    expect(await source.fetchBytes!(session(), doc('sorted/a.txt'))).toBeNull();
  });

  it('a host that is not built yet gives nothing', async () => {
    const source = createSharedFolderSource(() => null);
    expect(await source.fetchBytes!(session(), doc('sorted/a.txt'))).toBeNull();
    const out: unknown[] = [];
    for await (const b of source.pull(session(), null)) out.push(b);
    expect(out).toEqual([]);
  });
});

it('a live pull wakes when the manifest changes and ends when cancelled', async () => {
  const { d, sorted } = await leader();
  write(path.join(sorted, 'a.txt'), 'one');
  await scan(d);
  const source = createSharedFolderSource(() => hostOf(d));
  const ac = new AbortController();
  const seen: string[] = [];
  const done = (async () => {
    for await (const b of source.pull(session(ac.signal, true), null))
      for (const i of b.items) seen.push(i.relPath);
  })();
  await new Promise((r) => setTimeout(r, 50));
  expect(seen).toEqual(['a.txt']);
  write(path.join(sorted, 'b.txt'), 'two');
  await scan(d); // the pass changes the manifest and tells onChange
  await new Promise((r) => setTimeout(r, 50));
  expect(seen).toEqual(['a.txt', 'b.txt']);
  ac.abort();
  await done;
});

describe('a root that is owed its reconcile', () => {
  it('is not parsed; it is listed again from the top once its reconcile has run', async () => {
    const d = await device('copy');
    const { sorted } = await withRoots(d);
    write(path.join(sorted, 'a.txt'), 'hello world');
    await d.db.run(
      `INSERT INTO shared_files(root, rel_path, sha256, bytes, mtime, rev) VALUES('sorted','a.txt',?,11,'t',5)`,
      [sha('hello world')],
    );
    await d.db.run(
      `INSERT INTO shared_mirror(root, rel_path, sha256, bytes, mtime_ms) VALUES('sorted','a.txt',?,11,0)`,
      [sha('hello world')],
    );
    const first = await pullAll(d);
    expect(first.docs).toEqual([]);
    expect(first.cursor).toMatchObject({ rev: 5, roots: [] });
    d.sync.set('leader');
    await d.svc.settled();
    const second = await pullAll(d, first.cursor);
    expect(ids(second.docs)).toEqual(['sorted/a.txt']);
  });

  it('serves no bytes for a document of an owed root', async () => {
    const d = await device('copy');
    const { sorted } = await withRoots(d);
    write(path.join(sorted, 'a.txt'), 'hello world');
    const source = createSharedFolderSource(() => hostOf(d));
    const doc = { accountId: 'x', externalId: 'sorted/a.txt' } as unknown as Document;
    await d.db.run(`INSERT INTO accounts(id, source, identifier, config, status, created_at) VALUES('x','shared-folder','shared','{}','connected','t')`).catch(() => {});
    expect(await source.fetchBytes!(session(), doc)).toBeNull();
  });
});

describe('a path from another device through a symlinked directory', () => {
  it('is neither parsed nor read', async () => {
    const { d, sorted } = await leader();
    await d.db.run(
      `INSERT INTO accounts(id, source, identifier, config, status, created_at)
       VALUES('acct-shared', 'shared-folder', 'shared', '{}', 'connecting', 'now')`,
    );
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-'));
    write(path.join(out, 'report.txt'), 'outside');
    fs.symlinkSync(out, path.join(sorted, 'Tax'));
    write(path.join(sorted, 'ok.txt'), 'inside');
    await d.db.run(
      `INSERT INTO shared_files(root, rel_path, sha256, bytes, mtime, rev) VALUES
         ('sorted','Tax/report.txt',?,7,'t',90), ('sorted','ok.txt',?,6,'t',91)`,
      [sha('outside'), sha('inside')],
    );
    const { docs } = await pullAll(d);
    expect(ids(docs)).toEqual(['sorted/ok.txt']);
    const source = createSharedFolderSource(() => hostOf(d));
    const doc = { accountId: 'acct-shared', externalId: 'sorted/Tax/report.txt' } as never;
    expect(await source.fetchBytes!(session(), doc)).toBeNull();
    expect(await d.svc.pathOf(doc)).toBeNull();
  });
});

describe('older bytes are never indexed as the current file', () => {
  it('a row whose file holds other bytes than the row names yields no document; a missing_here or deleted row neither serves bytes', async () => {
    const { d, sorted } = await leader();
    await d.db.run(
      `INSERT INTO accounts(id, source, identifier, config, status, created_at)
       VALUES('acct-shared', 'shared-folder', 'shared', '{}', 'connecting', 'now')`,
    );
    write(path.join(sorted, 'a.txt'), 'version one');
    write(path.join(sorted, 'b.txt'), 'bee');
    write(path.join(sorted, 'c.txt'), 'sea');
    await scan(d);
    // the leader's disk holds an older version than the row names
    await d.db.run(`UPDATE shared_files SET sha256 = ? WHERE rel_path = 'a.txt'`, [sha('version two')]);
    await d.db.run(`UPDATE shared_files SET missing_here = 1 WHERE rel_path = 'b.txt'`);
    await d.db.run(`UPDATE shared_files SET deleted = 1 WHERE rel_path = 'c.txt'`);
    const { docs } = await pullAll(d);
    expect(ids(docs)).toEqual([]);
    const source = createSharedFolderSource(() => hostOf(d));
    for (const rel of ['a', 'b', 'c'])
      expect(await source.fetchBytes!(session(), { accountId: 'acct-shared', externalId: `sorted/${rel}.txt` } as never)).toBeNull();
    // the row and the file agree again: it is indexed, and its bytes are served
    await d.db.run(`UPDATE shared_files SET sha256 = ? WHERE rel_path = 'a.txt'`, [sha('version one')]);
    expect(ids((await pullAll(d)).docs)).toEqual(['sorted/a.txt']);
    const bytes = await source.fetchBytes!(session(), { accountId: 'acct-shared', externalId: 'sorted/a.txt' } as never);
    expect(Buffer.from(bytes!).toString()).toBe('version one');
  });

  it('the document carries the hash of the bytes it was parsed from, which is the row\'s', async () => {
    const { d, sorted } = await leader();
    write(path.join(sorted, 'a.txt'), 'hello world');
    await scan(d);
    const { docs } = await pullAll(d);
    expect(docs[0].metadata).toMatchObject({ sha256: sha('hello world') });
  });
});
