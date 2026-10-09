/** @jest-environment node */
import fs from 'fs';
import os from 'os';
import path from 'path';

import type { AppDb } from '../../db/app-db';
import { bootCore, takeLaneWake, type CorePlatform } from '../boot';
import { LEDGER_REKEY_JOB_ID } from '../changes-maintenance';

/** One injected failure of the ledger re-key job's registration write. */
const fault = { failRegistration: 0 };

// The real bootCore over an in-process SQLite (no DB worker thread); the
// read-only worker fails to open, so reads fall back to the writer.
jest.mock('../../db/worker-client', () => {
  const actual = jest.requireActual('../../db/worker-client');
  const { openDb } = jest.requireActual('../../db/app-db');
  return {
    ...actual,
    openDbInWorker: async (
      dbPath: string,
      _file: string,
      opts?: { role?: string },
    ): Promise<AppDb> => {
      if (opts?.role === 'read') throw new Error('no read worker in tests');
      const db: AppDb = await openDb(dbPath);
      return new Proxy(db, {
        get(target, key, receiver) {
          const v = Reflect.get(target, key, receiver);
          if (key !== 'run' || typeof v !== 'function') return v;
          return async (sql: string, params?: unknown[]) => {
            if (
              fault.failRegistration > 0 &&
              /INSERT INTO schedule/.test(sql) &&
              params?.[0] === LEDGER_REKEY_JOB_ID
            ) {
              fault.failRegistration -= 1;
              throw new Error('db worker crashed');
            }
            return (v as (...a: unknown[]) => unknown).call(
              target,
              sql,
              params,
            );
          };
        },
      });
    },
  };
});

describe('ledger re-key repair through the real bootCore (#59 §0)', () => {
  let tmp: string;
  let p: CorePlatform | null = null;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kia-rekey-boot-'));
  });
  afterEach(async () => {
    await p?.shutdown();
    p = null;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('a transient failure of the job registration write still ends in a completed repair and one lane wake', async () => {
    // An upgraded corpus: migrated, but the one-shot repair never ran.
    const pre: AppDb = await jest
      .requireActual('../../db/app-db')
      .openDb(path.join(tmp, 'kiagent.db'));
    await pre.run(`DELETE FROM meta WHERE key = 'ledgerRekeyed'`);
    await pre.close();

    fault.failRegistration = 1;
    p = await bootCore({
      dataDir: tmp,
      encrypt: (s) => Buffer.from(s, 'utf8'),
      decrypt: (b) => b.toString('utf8'),
      env: () => ({ onBattery: false, thermal: 'nominal' }) as never,
      dbWorkerFile: 'unused',
    });
    // Let the boot-time registration run (and fail) before the store recovers.
    for (let i = 0; i < 20 && fault.failRegistration > 0; i += 1)
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 10));
    expect(fault.failRegistration).toBe(0);

    expect(await p.store.ledgerRekeyed()).toBe(false);
    p.startLedgerRekey(); // main.ts's one start, after scheduler.start()
    const end = Date.now() + 3_000;
    while (!(await p.store.ledgerRekeyed()) && Date.now() < end)
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 10));
    expect(await p.store.ledgerRekeyed()).toBe(true);
    await new Promise((r) => setTimeout(r, 20));
    expect(takeLaneWake(p)).toBe(true);
    p.startLedgerRekey(); // a second start is a no-op: no second wake
    await new Promise((r) => setTimeout(r, 50));
    expect(takeLaneWake(p)).toBe(false);
  });
});
