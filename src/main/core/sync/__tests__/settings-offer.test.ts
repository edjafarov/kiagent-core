/** Step 5 Task 5: the join offer carries the joiner's settings and connectors;
 *  the master adds what it lacks, once per offer (spec 7.9 rule 6). */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { openDb, type AppDb } from '../../../db/app-db';
import { migrate } from '../../store/schema';
import { openStore, type CoreStore } from '../../store/store';
import { createSyncService, type SettingsOffer } from '../service';

const deps = {
  encrypt: (s: string) => Buffer.from(s, 'utf8'),
  decrypt: (b: Buffer) => b.toString('utf8'),
  detectLanguages: () => ['eng'],
};
let dir: string;
let db: AppDb;
let store: CoreStore;
beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-settings-offer-'));
  db = await openDb(path.join(dir, 'a.db'));
  migrate(db._conn!);
  store = openStore(db, deps);
});
afterEach(async () => {
  await db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const svc = (readOnly = false) =>
  createSyncService({
    db, store, dbPath: db._conn!.name, workerFile: '', deviceId: () => 'seedseed-9999', readOnly: () => readOnly,
  });
const offer = { prefs: { 'a.b': 1 }, extensions: { 'kia.x': { enabled: true, ref: 'github:kia-plugins/x@v1' } } };

describe('exportSettings', () => {
  it('returns what the installed handler offers', async () => {
    const sync = svc();
    sync.setSettingsOffer({ export: async () => offer, import: async () => ({ prefs: [], extensions: [] }) });
    expect(await sync.exportSettings()).toEqual(offer);
  });
  it('is an empty offer before the handler is installed', async () => {
    expect(await svc().exportSettings()).toEqual({ prefs: {}, extensions: {} });
  });
});

describe('importSettings', () => {
  const handler = () => {
    const seen: unknown[] = [];
    const h: SettingsOffer & { seen: unknown[]; fail: boolean } = {
      seen,
      fail: false,
      export: async () => offer,
      import: async (s) => {
        if (h.fail) throw new Error('boom');
        seen.push(s);
        return { prefs: Object.keys(s.prefs), extensions: Object.keys(s.extensions) };
      },
    };
    return h;
  };

  it('hands the offer to the handler and reports what it added', async () => {
    const sync = svc();
    const h = handler();
    sync.setSettingsOffer(h);
    expect(await sync.importSettings('o1', offer)).toEqual({ prefs: ['a.b'], extensions: ['kia.x'] });
    expect(h.seen).toEqual([offer]);
  });

  it('a repeated offer id changes nothing the second time', async () => {
    const sync = svc();
    const h = handler();
    sync.setSettingsOffer(h);
    await sync.importSettings('o1', offer);
    expect(await sync.importSettings('o1', offer)).toEqual({ prefs: [], extensions: [] });
    expect(h.seen).toHaveLength(1);
    await sync.importSettings('o2', offer);
    expect(h.seen).toHaveLength(2);
  });

  it('a failed import is retried under the same offer id', async () => {
    const sync = svc();
    const h = handler();
    sync.setSettingsOffer(h);
    h.fail = true;
    await expect(sync.importSettings('o1', offer)).rejects.toThrow('boom');
    h.fail = false;
    expect(await sync.importSettings('o1', offer)).toEqual({ prefs: ['a.b'], extensions: ['kia.x'] });
  });

  it('refuses on a device that is not the seed, and without a handler', async () => {
    const ro = svc(true);
    ro.setSettingsOffer(handler());
    await expect(ro.importSettings('o1', offer)).rejects.toThrow(/not the seed/);
    await expect(svc().importSettings('o1', offer)).rejects.toThrow(/not ready/);
  });

  it('shapes a hostile offer before the handler sees it', async () => {
    const sync = svc();
    const h = handler();
    sync.setSettingsOffer(h);
    await sync.importSettings('o1', { prefs: null, extensions: [] } as never);
    expect(h.seen).toEqual([{ prefs: {}, extensions: {} }]);
  });
});
