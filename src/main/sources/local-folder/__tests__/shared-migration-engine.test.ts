/**
 * @jest-environment node
 *
 * The real store, engine and local-folder source: a folder that becomes
 * shared is migrated by exact refs, and the engine's mass-archive guard does
 * not refuse the reconcile that follows.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { Account, AccountId } from '@shared/contracts';
import type { FolderScopeUpdate } from '@shared/contracts';

import { createEngine } from '../../../core/engine/engine';
import { migrateLocalFolders } from '../../../core/shared-folders/migrate';
import { openStore, type CoreStore } from '../../../core/store/store';
import { openDb, type AppDb } from '../../../db/app-db';
import { createInlineConverter } from '../../../core/converter/converter';
import { createLocalFolderSource } from '../local-folder-source';
import { folderScopedConfig } from '../folder-roots';

const noopLogs = { log: () => {} };
const waitFor = async (cond: () => Promise<boolean>, ms = 8000) => {
  const t0 = Date.now();
  while (!(await cond())) {
    if (Date.now() - t0 > ms) throw new Error('waitFor timeout');
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 25));
  }
};

let dir: string;
let parent: string;
let shared: string;
let store: CoreStore;
let db: AppDb;
let excluded: string[];

const SIBLINGS = 60;
const SHARED = 150; // 210 documents, 71% of them under the shared folder: past both limits of the guard

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-mig-'));
  parent = path.join(dir, 'Documents');
  shared = path.join(parent, 'Scans', 'Sorted');
  fs.mkdirSync(shared, { recursive: true });
  for (let i = 0; i < SIBLINGS; i += 1) fs.writeFileSync(path.join(parent, `s${i}.txt`), `sibling ${i}`);
  for (let i = 0; i < SHARED; i += 1) fs.writeFileSync(path.join(shared, `f${i}.txt`), `shared ${i}`);
  excluded = [];
  db = await openDb(path.join(dir, 'test.db'));
  store = await openStore(db, {
    encrypt: (s: string) => Buffer.from(s, 'utf8'),
    decrypt: (b: Buffer) => b.toString('utf8'),
    detectLanguages: () => [],
  });
});
afterEach(async () => {
  await engineOnce?.stopAll?.();
  await store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const source = () =>
  createLocalFolderSource({ converter: createInlineConverter(), excluded: () => excluded });
let engineOnce: ReturnType<typeof createEngine> | null = null;
/** ONE engine per test, as in the app: applyScope restarts the account on it. */
const makeEngine = () => {
  engineOnce ??= createEngine({
    store,
    sources: { get: (id: string) => (id === 'local-folder' ? source() : undefined) },
    inference: { complete: async () => 's', see: async () => 's', read: async () => 's', hear: async () => 's' },
    convert: async (input: never) => input,
    logs: noopLogs,
  } as never);
  return { engine: engineOnce };
};
const live = async (accountId: AccountId) => (await store.read.count({ account: accountId })) as number;

/** One engine cycle: runs until the reconcile pass has recorded its outcome
 *  (and `until` holds), then stops it. */
const cycle = async (account: Account, until: () => Promise<boolean> = async () => true) => {
  const { engine } = makeEngine();
  const status = jest.spyOn(store, 'setAccountStatus');
  const handle = engine.run(account);
  await waitFor(async () =>
    status.mock.calls.some(
      ([, patch]) => (patch as { errorScope?: string }).errorScope === 'reconcile' || Boolean((patch as { error?: string }).error),
    ) && (await until()),
  );
  await handle.stop();
  status.mockRestore();
  return (await store.account(account.id))!;
};

async function indexEverything() {
  const account = await store.createAccount({
    source: 'local-folder',
    identifier: 'this-machine',
    config: { ...folderScopedConfig({}, [{ id: parent, name: 'Documents' }]), watch: false },
    status: 'connecting',
  });
  await cycle(account, async () => (await live(account.id)) === SIBLINGS + SHARED);
  return account;
}
const reconcileOnce = async (accountId: AccountId) => cycle((await store.account(accountId))!);
const access = (engine: ReturnType<typeof makeEngine>['engine']) => ({
  accounts: async () =>
    (await store.read.accounts())
      .filter((a) => a.source === 'local-folder')
      .map((a) => ({ id: a.id as string, roots: [parent] })),
  quiesce: async () => {},
  archive: async (accountId: string, refs: { externalId: string; type: string }[]) => {
    const a = (await store.account(accountId as AccountId))!;
    await engine.applyScope(
      a.id,
      {
        config: a.config as FolderScopeUpdate['config'],
        cursor: a.cursor,
        archiveScopeRootIds: [],
        archiveRefs: refs,
      },
      JSON.stringify(a.config),
    );
  },
});

it('the migration archives exactly the documents under the root, and the next reconcile is not refused', async () => {
  const account = await indexEverything();
  excluded = [shared];
  const { engine } = makeEngine();
  await migrateLocalFolders(
    { db, localFolders: access(engine), log: () => {} },
    shared,
  );
  expect(await live(account.id)).toBe(SIBLINGS);
  const archived = await store.read.search({ account: account.id, includeArchived: true, limit: 1000 } as never);
  expect(archived.length).toBe(SIBLINGS + SHARED);
  const after = await reconcileOnce(account.id);
  expect(after.lastError ?? null).toBeNull();
  expect(await live(account.id)).toBe(SIBLINGS);
});
