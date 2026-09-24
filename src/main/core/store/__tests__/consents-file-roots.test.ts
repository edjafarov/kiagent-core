/** @jest-environment node */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { openDb } from '@main/db/app-db';
import { openStore } from '@main/core/store/store';
import type { Cap, ExtensionId } from '@shared/contracts';

describe('consents.fileRoots', () => {
  let tmp: string;
  let store: ReturnType<typeof openStore>;
  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kia-consent-'));
    store = openStore(await openDb(path.join(tmp, 'kiagent.db')), {
      encrypt: (s) => Buffer.from(s, 'utf8'),
      decrypt: (b) => b.toString('utf8'),
      detectLanguages: () => [],
    });
  });
  afterEach(async () => {
    await store.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('empty roots round-trip and a root list round-trips', async () => {
    const id = 'x.y' as ExtensionId;
    const base = {
      extensionId: id,
      caps: ['files'] as Cap[],
      manifestVersion: '1.0.0',
      grantedAt: 't',
      pages: false,
    };
    await store.consents.record({ ...base, fileRoots: [] });
    expect((await store.consents.latest(id))?.fileRoots).toEqual([]);
    const roots = [{ id: 'claude', path: '~/.claude' }];
    await store.consents.record({ ...base, fileRoots: roots });
    expect((await store.consents.latest(id))?.fileRoots).toEqual(roots);
  });

  it('persists the pages bit; a record without it reads false', async () => {
    const base = { caps: [] as Cap[], manifestVersion: '1', grantedAt: 't', fileRoots: [] };
    await store.consents.record({ ...base, extensionId: 'x' as ExtensionId, pages: true });
    expect((await store.consents.latest('x' as ExtensionId))?.pages).toBe(true);
    await store.consents.record({ ...base, extensionId: 'y' as ExtensionId, pages: false });
    expect((await store.consents.latest('y' as ExtensionId))?.pages).toBe(false);
  });
});
