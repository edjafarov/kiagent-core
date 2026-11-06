/** @jest-environment node */
/** The public sync surface is ONE list (SYNC_SURFACE_METHODS). */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { SYNC_SURFACE_METHODS } from '@shared/contracts';

import { syncSurface } from '../../../platform/host-surfaces';
import { openDb } from '../../../db/app-db';
import { migrate } from '../../store/schema';
import { openStore } from '../../store/store';
import { readGateSync } from '../role';
import { createSyncService } from '../service';

it('every public sync method is a function on createSyncService', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-surface-'));
  const db = await openDb(path.join(dir, 'a.db'));
  try {
    migrate(db._conn!);
    const store = openStore(db, {
      encrypt: (s: string) => Buffer.from(s, 'utf8'),
      decrypt: (b: Buffer) => b.toString('utf8'),
      detectLanguages: () => ['eng'],
    });
    const svc = createSyncService({
      bootGate: readGateSync(db._conn!),
      db,
      store,
      dbPath: path.join(dir, 'a.db'),
      workerFile: '',
      log: () => undefined,
    }) as unknown as Record<string, unknown>;
    for (const m of SYNC_SURFACE_METHODS)
      expect(typeof svc[m]).toBe('function');
  } finally {
    await db.close?.();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it('syncSurface exposes exactly the list', () => {
  expect(Object.keys(syncSurface(undefined)).sort()).toEqual(
    [...SYNC_SURFACE_METHODS].sort(),
  );
});
