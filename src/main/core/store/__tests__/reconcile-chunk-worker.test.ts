/**
 * @jest-environment node
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { DocumentInput } from '@shared/contracts';

import {
  createWorkerEnv,
  WORKER_ENTRY,
} from '../../../db/__tests__/worker-test-env';
import { openDbInWorker } from '../../../db/worker-client';
import { openStore } from '../store';

jest.setTimeout(120_000);

it('a writer call issued between archive chunks completes before the next chunk (real DB worker)', async () => {
  const env = createWorkerEnv('reconcile-chunk');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-rchunk-'));
  const db = await openDbInWorker(path.join(dir, 'kiagent.db'), WORKER_ENTRY, {
    execArgv: env.execArgv,
  });
  const store = openStore(db, {
    encrypt: (s: string) => Buffer.from(s, 'utf8'),
    decrypt: (b: Buffer) => b.toString('utf8'),
    detectLanguages: () => ['eng'],
  });
  try {
    const account = (
      await store.createAccount({ source: 'test', identifier: 'me' })
    ).id;
    const docs = Array.from(
      { length: 40 },
      (_, i): DocumentInput => ({
        externalId: `d${i}`,
        type: 'note',
        title: `d${i}`,
        markdown: `body ${i}`,
        metadata: {},
        createdAt: null,
      }),
    );
    await store.commit({ account, cursor: 1, documents: docs });
    const head = await store.headSeq();
    await store.reconcileBegin(account);
    await store.reconcileStage(account, [{ externalId: 'd0', type: 'note' }]);
    const order: string[] = [];
    const c1 = store
      .reconcileArchiveChunk(account, head, 10)
      .then(() => order.push('chunk1'));
    const w = store
      .setAccountStatus(account, { error: null })
      .then(() => order.push('writer'));
    const c2 = store
      .reconcileArchiveChunk(account, head, 10)
      .then(() => order.push('chunk2'));
    await Promise.all([c1, w, c2]);
    expect(order).toEqual(['chunk1', 'writer', 'chunk2']);
  } finally {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
    env.cleanup();
  }
});
