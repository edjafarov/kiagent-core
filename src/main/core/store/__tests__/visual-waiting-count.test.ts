import fs from 'fs';
import os from 'os';
import path from 'path';

import type { AccountId, DocumentInput } from '@shared/contracts';

import { openDb, type AppDb } from '../../../db/app-db';
import { ensureQueryIndexes } from '../schema';
import { openStore, VISUAL_WAITING_DEFERRED_SQL } from '../store';
import type { CoreStore } from '../store';

// Test-only literal: the production code derives it (VISION_CONSUMER).
const C = 'worker:vision:v1';

const deps = {
  encrypt: (s: string) => Buffer.from(s, 'utf8'),
  decrypt: (b: Buffer) => b.toString('utf8'),
  detectLanguages: () => ['eng'],
};

function file(
  externalId: string,
  metadata: Record<string, unknown>,
  over: Partial<DocumentInput> = {},
): DocumentInput {
  return {
    externalId,
    type: 'file',
    title: `Title ${externalId}`,
    markdown: '',
    metadata,
    createdAt: '2026-01-01T00:00:00Z',
    ...over,
  };
}

const IMG = (sizeBytes: number) => ({ mime: 'image/png', sizeBytes });

describe('store.visualWaitingCount', () => {
  let dir: string;
  let db: AppDb;
  let store: CoreStore;
  let accountId: AccountId;

  const seqOf = async (externalId: string): Promise<number> =>
    (
      (await db.all(`SELECT seq FROM documents WHERE external_id = ?`, [
        externalId,
      ])) as Array<{ seq: number }>
    )[0].seq;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-vwc-'));
    db = await openDb(path.join(dir, 'test.db'));
    // The partial indexes the pinned queries use (boot runs this too).
    ensureQueryIndexes(db._conn!);
    store = openStore(db, deps);
    accountId = (
      await store.createAccount({
        source: 'test',
        identifier: 'me@example.com',
      })
    ).id;
  });

  afterEach(async () => {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function seed(docs: DocumentInput[]) {
    await store.commit({ account: accountId, documents: docs, cursor: 'c' });
  }

  it('counts eligible images with no ledger outcome', async () => {
    await seed([
      file('A', IMG(20 * 1024)), // counts
      file('B', IMG(4 * 1024)), // tiny logo: size gate
      file('C', { conversion: { status: 'needs-ocr' } }), // pdf exemption path
    ]);
    expect(await store.visualWaitingCount(C)).toBe(2);
  });

  it('deferred counts, failed and done do not', async () => {
    await seed([
      file('A', IMG(20 * 1024)),
      file('C', { conversion: { status: 'needs-ocr' } }),
      file('D', { ...IMG(20 * 1024), extraction: { engine: 'x' } }),
    ]);
    await store.ledgerRecordMany(C, [
      { seq: await seqOf('A'), attempts: 1, outcome: 'deferred' },
      { seq: await seqOf('C'), attempts: 3, outcome: 'failed' },
    ]);
    expect(await store.visualWaitingCount(C)).toBe(1);
  });

  it('a done outcome on the current change does not count', async () => {
    await seed([file('A', IMG(20 * 1024))]);
    await store.ledgerRecordMany(C, [
      { seq: await seqOf('A'), attempts: 1, outcome: 'done' },
    ]);
    expect(await store.visualWaitingCount(C)).toBe(0);
  });

  it('a later skip change never hides an earlier deferred change (spec §7)', async () => {
    await seed([file('E', IMG(20 * 1024))]);
    const first = await seqOf('E');
    await store.ledgerRecordMany(C, [
      { seq: first, attempts: 1, outcome: 'deferred' },
    ]);
    await seed([file('E', IMG(20 * 1024), { title: 'Renamed E' })]);
    const second = await seqOf('E');
    expect(second).toBeGreaterThan(first);
    await store.ledgerRecordMany(C, [
      { seq: second, attempts: 0, outcome: 'skip' },
    ]);
    expect(await store.visualWaitingCount(C)).toBe(1);
  });

  it('the deferred branch is driven by work_ledger_active and the PKs', async () => {
    const plan = (
      (await db.all(`EXPLAIN QUERY PLAN ${VISUAL_WAITING_DEFERRED_SQL}`, [
        C,
      ])) as Array<{ detail: string }>
    )
      .map((r) => r.detail)
      .join('\n');
    expect(plan).toMatch(/work_ledger_active/);
    expect(plan).not.toMatch(/SCAN changes/);
  });
});
