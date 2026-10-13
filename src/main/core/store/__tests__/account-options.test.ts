import fs from 'fs';
import os from 'os';
import path from 'path';
import { openDb } from '../../../db/app-db';
import { openStore, type CoreStore } from '../store';

let dir: string;
let store: CoreStore;
beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-opts-'));
  store = openStore(await openDb(path.join(dir, 'test.db')), {
    encrypt: (s: string) => Buffer.from(s, 'utf8'),
    decrypt: (b: Buffer) => b.toString('utf8'),
    detectLanguages: () => [],
  });
});
afterEach(async () => {
  await store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
const make = (config: Record<string, unknown> = {}) =>
  store.createAccount({
    source: 'claude-code',
    identifier: '~/.claude',
    config,
  });

it('setAccountOption writes options.<key> and keeps other keys', async () => {
  const a = await make({ roots: ['/x'] });
  await store.setAccountOption(a.id, 'skipSubagents', false);
  await store.setAccountOption(a.id, 'other', true);
  expect((await store.account(a.id))?.config).toEqual({
    roots: ['/x'],
    options: { skipSubagents: false, other: true },
  });
});

it('setAccountOption logs only on a real change', async () => {
  const a = await make();
  await store.setAccountOption(a.id, 'skipSubagents', false);
  const head = await store.headSeq();
  await store.setAccountOption(a.id, 'skipSubagents', false);
  expect(await store.headSeq()).toBe(head);
});

it('setAccountOption replaces a non-object options', async () => {
  const a = await make();
  await store.setAccountConfig(a.id, { x: 1 }); // options absent
  await store.setAccountOption(a.id, 'k', true);
  expect((await store.account(a.id))?.config).toEqual({
    x: 1,
    options: { k: true },
  });
});

it('config op keeps the row options and drops an incoming options', async () => {
  const a = await make();
  await store.setAccountOption(a.id, 'skipSubagents', false);
  await store.setAccountConfig(a.id, {
    outbound: { mode: 'review' },
    options: { skipSubagents: true },
  });
  expect((await store.account(a.id))?.config).toEqual({
    outbound: { mode: 'review' },
    options: { skipSubagents: false },
  });
});

it('config op drops an incoming options when the row has none', async () => {
  const a = await make();
  await store.setAccountConfig(a.id, { options: { skipSubagents: true } });
  expect((await store.account(a.id))?.config).toEqual({});
});

it('create upsert keeps options (re-add) and a fresh insert never seeds them', async () => {
  const fresh = await make({ options: { skipSubagents: false } });
  expect((await store.account(fresh.id))?.config).toEqual({});
  await store.setAccountOption(fresh.id, 'skipSubagents', false);
  const again = await make({ connector: 1 });
  expect(again.id).toBe(fresh.id);
  expect((await store.account(fresh.id))?.config).toEqual({
    connector: 1,
    options: { skipSubagents: false },
  });
});

it('applyFolderScope keeps options', async () => {
  const a = await make({ folderRoots: [] });
  await store.setAccountOption(a.id, 'k', false);
  const acc = await store.account(a.id);
  const res = await store.applyFolderScope({
    accountId: a.id,
    config: { folderRoots: [{ id: 'r1' }] },
    cursor: null,
    archiveScopeRootIds: [],
    reattributeScopeRoots: [],
    archiveRefs: [],
    expectedConfigJson: JSON.stringify(acc!.config),
  });
  expect(res.stale).toBe(false);
  expect((await store.account(a.id))?.config).toEqual(
    expect.objectContaining({ options: { k: false } }),
  );
});

it('two option writes with a whole-config write between keep both', async () => {
  const a = await make();
  await Promise.all([
    store.setAccountOption(a.id, 'a', true),
    store.setAccountConfig(a.id, { z: 1 }),
    store.setAccountOption(a.id, 'b', false),
  ]);
  expect((await store.account(a.id))?.config.options).toEqual({
    a: true,
    b: false,
  });
});
