import fs from 'fs';
import path from 'path';

import type { Batch, Session } from '@shared/contracts';

import { sharedSubtrees } from '../../../sources';
import { createSharedFolderSource, type SharedFolderCursor } from '../../../sources/shared-folder/shared-folder-source';
import type { SharedFileItem } from '../../../sources/shared-folder/to-document';
import { closeDevices, device, withRoots, type Device } from './helpers/device';
import { sha } from './helpers/fake-transport';

afterEach(closeDevices);

const MARKER = path.join('.kia-sync', 'root');
const settle = async (d: Device) => {
  d.svc.kick();
  await d.svc.settled();
};
const write = (file: string, text: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const rowCount = async (d: Device) => Number((await d.db.all(`SELECT count(*) AS n FROM shared_files`))[0].n);
const enabledKey = async (d: Device) => d.db.all(`SELECT value FROM meta WHERE key = 'shared-folders:enabled'`);

/** A host that records what the wiring does, and a device with documents under its roots. */
function wiring() {
  const calls = { ensure: 0, archived: [] as string[] };
  return {
    calls,
    over: {
      ensureAccount: async () => {
        calls.ensure += 1;
      },
      localFolders: {
        quiesce: async () => {},
        accounts: async () => [{ id: 'lf', roots: [] as string[] }],
        archive: async (_id: string, refs: { externalId: string }[]) => {
          calls.archived.push(...refs.map((r) => r.externalId));
        },
      },
    },
  };
}

async function alone() {
  const w = wiring();
  const d = await device('leader', w.over, { alone: true });
  const roots = await withRoots(d);
  w.over.localFolders.accounts = async () => [{ id: 'lf', roots: [d.dir] }];
  await d.db.run(
    `INSERT INTO accounts(id, source, identifier, config, status, created_at) VALUES('lf','local-folder','lf','{}','connecting','now')`,
  );
  await d.db.run(
    `INSERT INTO documents(id, account_id, external_id, type, content_hash, ingested_at, updated_at, archived_at)
     VALUES('doc-1','lf',?, 'file','h','now','now',NULL)`,
    [`${roots.incoming.replace(/\\/g, '/')}/old.pdf`],
  );
  return { d, w, ...roots };
}

describe('a device with no other computer in its account', () => {
  it('only remembers the roots: no marker, no scan, no account, no migration, no exclusion', async () => {
    const { d, w, incoming, sorted } = await alone();
    write(path.join(incoming, 'a.pdf'), 'a');
    write(path.join(sorted, 'b.pdf'), 'b');
    await settle(d);
    expect(d.svc.roots()).toEqual({ incoming, sorted });
    expect(d.svc.enabled()).toBe(false);
    expect(fs.existsSync(path.join(incoming, MARKER))).toBe(false);
    expect(fs.existsSync(path.join(sorted, MARKER))).toBe(false);
    expect(await rowCount(d)).toBe(0);
    expect(d.hashed).toEqual([]);
    expect(w.calls.ensure).toBe(0);
    expect(w.calls.archived).toEqual([]);
    expect(await d.db.all(`SELECT 1 FROM accounts WHERE source = 'shared-folder'`)).toEqual([]);
    expect(await enabledKey(d)).toEqual([]);
    expect(sharedSubtrees({ db: d.db, sharedFolders: d.svc })).toEqual([]);
  });

  it('answers as if nothing were shared, whatever the tables hold', async () => {
    const { d, incoming } = await alone();
    await d.db.run(
      `INSERT INTO accounts(id, source, identifier, config, status, created_at) VALUES('acct','shared-folder','shared','{}','connecting','now')`,
    );
    write(path.join(incoming, 'a.pdf'), 'a');
    await d.db.run(
      `INSERT INTO shared_files(root, rel_path, sha256, bytes, mtime, missing_here, deleted, parked, rev)
       VALUES('incoming','a.pdf',?,1,'t',0,0,0,5)`,
      [sha('a')],
    );
    await d.db.run(`INSERT INTO shared_capture_files(capture_id, sha256) VALUES('cap', ?)`, [sha('a')]);
    const abs = path.join(incoming, 'a.pdf');
    expect(await d.svc.resolve(abs)).toBeNull();
    expect(await d.svc.pathOf({ accountId: 'acct', externalId: 'incoming/a.pdf' })).toBeNull();
    expect(await d.svc.fileOfCapture('cap')).toBeNull();
    expect(await d.svc.listForSorting()).toEqual([]);
    expect(d.svc.rootStatus('incoming')).toBe('unset');
    expect(d.svc.rootStatus('sorted')).toBe('unset');
    expect(d.svc.usable('incoming')).toBe(false);
    await expect(d.svc.serve.open({ root: 'incoming', relPath: 'a.pdf', sha256: sha('a') })).rejects.toThrow(/paused/);
    await expect(d.svc.serve.stagingFile('incoming')).rejects.toThrow(/paused/);
    await expect(d.svc.serve.remove({ root: 'incoming', relPath: 'a.pdf', sha256: sha('a') })).rejects.toThrow(/paused/);
    expect(fs.existsSync(path.join(incoming, '.kia-sync'))).toBe(false);
    expect(fs.existsSync(abs)).toBe(true);
  });

  it('the source lists nothing', async () => {
    const { d } = await alone();
    await d.db.run(
      `INSERT INTO shared_files(root, rel_path, sha256, bytes, mtime, missing_here, deleted, parked, rev)
       VALUES('incoming','a.pdf',?,1,'t',0,1,0,5)`,
      [sha('a')],
    );
    const source = createSharedFolderSource(() => ({ db: d.db, sharedFolders: d.svc }));
    const session = {
      account: { id: 'acct', source: 'shared-folder', identifier: 'shared', config: { watch: false } },
      signal: new AbortController().signal,
      credentials: async () => null,
      saveCredentials: async () => {},
      log: () => {},
    } as unknown as Session;
    const batches: Batch<SharedFolderCursor, SharedFileItem>[] = [];
    for await (const b of source.pull(session, null)) batches.push(b);
    expect(batches).toEqual([]);
  });
});

it('no folder is watched until the folders are shared', async () => {
  const watched: string[] = [];
  const over = {
    watch: (root: string) => {
      watched.push(root);
      return { close: async () => {} };
    },
  };
  const d = await device('leader', over, { alone: true });
  await withRoots(d);
  await settle(d);
  d.sync.set('fenced'); // a role change restarts the watchers
  d.sync.set('leader');
  await d.svc.settled();
  expect(watched).toEqual([]);
  d.sync.setPeer(true);
  await d.svc.settled();
  expect(watched).toHaveLength(2);
});

describe('when another computer joins the account', () => {
  it('shared folders start as if the roots had just been set', async () => {
    const { d, w, incoming, sorted } = await alone();
    write(path.join(incoming, 'a.pdf'), 'a');
    await settle(d);
    let changes = 0;
    d.svc.onChange(() => void (changes += 1));
    d.sync.setPeer(true);
    await d.svc.settled();
    expect(d.svc.enabled()).toBe(true);
    expect(changes).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(incoming, MARKER))).toBe(true);
    expect(fs.existsSync(path.join(sorted, MARKER))).toBe(true);
    expect(w.calls.ensure).toBe(1);
    expect(w.calls.archived).toHaveLength(1); // the migration ran
    expect(await rowCount(d)).toBe(1);
    expect(d.svc.rootStatus('incoming')).toBe('ok');
    expect(sharedSubtrees({ db: d.db, sharedFolders: d.svc })).toEqual([incoming, sorted]);
    expect((await enabledKey(d))[0].value).toBe('1');
  });

  it('a device that is a copy counts as having a peer', async () => {
    const d = await device('copy', {}, { alone: true });
    await withRoots(d);
    expect(d.svc.enabled()).toBe(true);
  });

  it('roots set later are used at once; with no roots set a peer enables nothing', async () => {
    const d = await device('leader', {}, { alone: true });
    d.sync.setPeer(true);
    await d.svc.settled();
    expect(d.svc.enabled()).toBe(false);
    expect(await enabledKey(d)).toEqual([]);
    const { incoming } = await withRoots(d);
    expect(d.svc.enabled()).toBe(true);
    expect(fs.existsSync(path.join(incoming, MARKER))).toBe(true);
  });

  it('stays enabled after the other computer leaves, and after a restart that says alone', async () => {
    const { d, incoming } = await alone();
    d.sync.setPeer(true);
    await d.svc.settled();
    d.sync.setPeer(false);
    await d.svc.settled();
    expect(d.svc.enabled()).toBe(true);
    const svc = await d.restart();
    expect(svc.enabled()).toBe(true);
    expect(svc.rootStatus('incoming')).toBe('ok');
    expect(fs.existsSync(path.join(incoming, MARKER))).toBe(true);
  });

  it('a restart that finds a peer in the role wire enables it', async () => {
    const { d, incoming } = await alone();
    d.sync.setPeer(true, false); // nobody was listening when it happened
    expect(d.svc.enabled()).toBe(false);
    const svc = await d.restart();
    await svc.settled();
    expect(svc.enabled()).toBe(true);
    expect(fs.existsSync(path.join(incoming, MARKER))).toBe(true);
  });
});
