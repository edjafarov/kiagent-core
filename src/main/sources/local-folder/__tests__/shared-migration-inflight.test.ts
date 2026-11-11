/**
 * @jest-environment node
 *
 * The real store, engine and local-folder source, with a pull held open: a
 * local-folder pull walks the folder with NO exclusions, then sharing starts.
 * Whatever that pull built must not land as local-folder documents under the
 * shared root, even though nothing under it was committed when the migration
 * looked (so there was nothing to archive).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { Account, AccountId, Source } from '@shared/contracts';
import type { FolderScopeUpdate } from '@shared/contracts';

import { createEngine } from '../../../core/engine/engine';
import { migrateLocalFolders } from '../../../core/shared-folders/migrate';
import { openStore, type CoreStore } from '../../../core/store/store';
import { openDb } from '../../../db/app-db';
import { createInlineConverter } from '../../../core/converter/converter';
import { createLocalFolderSource } from '../local-folder-source';
import { folderScopedConfig } from '../folder-roots';

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
let engine: ReturnType<typeof createEngine>;
let excluded: string[];

afterEach(async () => {
  await engine?.stopAll?.();
  await store?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

it('a pull held open with the old exclusions cannot commit a document under the shared root after the migration', async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-inflight-'));
  parent = path.join(dir, 'Documents');
  shared = path.join(parent, 'Sorted');
  fs.mkdirSync(shared, { recursive: true });
  for (let i = 0; i < 3; i += 1) fs.writeFileSync(path.join(parent, `s${i}.txt`), `sibling ${i}`);
  for (let i = 0; i < 3; i += 1) fs.writeFileSync(path.join(shared, `f${i}.txt`), `shared ${i}`);
  excluded = [];
  const db = await openDb(path.join(dir, 'test.db'));
  store = await openStore(db, {
    encrypt: (s: string) => Buffer.from(s, 'utf8'),
    decrypt: (b: Buffer) => b.toString('utf8'),
    detectLanguages: () => [],
  });

  const real = createLocalFolderSource({ converter: createInlineConverter(), excluded: () => excluded });
  // The first pull walks with no exclusions, then is held before its first
  // batch is handed to the engine, until the test lets it go (or it is aborted).
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let held = false;
  let pulls = 0;
  const source = {
    ...real,
    pull: (session: never, cursor: never) => {
      const inner = (real.pull as (s: never, c: never) => AsyncGenerator<unknown>)(session, cursor);
      pulls += 1;
      if (pulls > 1) return inner;
      return (async function* () {
        for await (const batch of inner) {
          if (!held) {
            held = true;
            await new Promise<void>((resolve) => {
              const sig = (session as { signal: AbortSignal }).signal;
              void gate.then(resolve);
              sig.addEventListener('abort', () => resolve(), { once: true });
            });
            if ((session as { signal: AbortSignal }).signal.aborted) return;
          }
          yield batch;
        }
      })();
    },
  } as unknown as Source;
  engine = createEngine({
    store,
    sources: { get: (id: string) => (id === 'local-folder' ? source : undefined) },
    inference: { complete: async () => 's', see: async () => 's', read: async () => 's', hear: async () => 's' },
    convert: async (input: never) => input,
    logs: { log: () => {} },
  } as never);

  const account: Account = await store.createAccount({
    source: 'local-folder',
    identifier: 'this-machine',
    config: { ...folderScopedConfig({}, [{ id: parent, name: 'Documents' }]), watch: false },
    status: 'connecting',
  });
  engine.run(account);
  await waitFor(async () => held);

  // Sharing starts: the exclusion is in force, nothing is committed yet.
  excluded = [shared];
  expect(await store.read.count({ account: account.id as AccountId })).toBe(0);
  const access = {
    accounts: async () => [{ id: account.id as string, roots: [parent] }],
    quiesce: async (id: string) => {
      const a = (await store.account(id as AccountId))!;
      await engine.applyScope(
        a.id,
        {
          config: a.config as FolderScopeUpdate['config'],
          cursor: a.cursor,
          archiveScopeRootIds: [],
          archiveRefs: [],
        },
        JSON.stringify(a.config),
      );
    },
    archive: async (id: string, refs: { externalId: string; type: string }[]) => {
      const a = (await store.account(id as AccountId))!;
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
  };
  await migrateLocalFolders({ db, localFolders: access, log: () => {} }, shared);

  release(); // the held pull may now hand over what it built
  await waitFor(async () => ((await store.read.count({ account: account.id as AccountId })) as number) >= 3);
  await engine.stopAll?.();
  const live = (await store.read.search({ account: account.id, limit: 100 } as never)) as { externalId?: string; external_id?: string }[];
  const ids = live.map((d) => d.externalId ?? d.external_id ?? '');
  expect(ids.filter((id) => id.startsWith(`${shared}/`))).toEqual([]);
  expect(ids.length).toBe(3);
});
