import fs from 'fs';
import os from 'os';
import path from 'path';

import type { AccountId, DocumentInput } from '@shared/contracts';

import { openDb, type AppDb } from '../../../db/app-db';
import { VISION_WORKER } from '../../../workers/vision/identity';
import { ensureQueryIndexes } from '../schema';
import {
  openStore,
  VISUAL_WAITING_CURRENT_SQL,
  VISUAL_WAITING_DEFERRED_SQL,
} from '../store';
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

  it('pre-repair: a later skip change never hides an earlier deferred change (UNION plan)', async () => {
    await db.run(`DELETE FROM meta WHERE key = 'ledgerRekeyed'`);
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
    // The repair turns it into (second, deferred): still exactly 1, now
    // counted by the current-only plan.
    while (!(await store.ledgerRekeyPage()).done) {
      // page until done
    }
    expect(await store.visualWaitingCount(C)).toBe(1);
  });

  it('re-keyed: the count runs the current-seq plan only (no changes join)', async () => {
    await seed([file('A', IMG(20 * 1024))]);
    const spy = jest.spyOn(db, 'all');
    await store.visualWaitingCount(C);
    const counts = spy.mock.calls
      .map(([sql]) => sql as string)
      .filter((sql) => /COUNT\(\*\)/.test(sql));
    expect(counts).toHaveLength(1);
    expect(counts[0]).not.toMatch(/\bJOIN changes\b/);
  });

  it('on fixtures without stale rows both plans give the same total', async () => {
    await seed([
      file('A', IMG(20 * 1024)),
      file('B', IMG(4 * 1024)),
      file('C', { conversion: { status: 'needs-ocr' } }),
      file('D', { ...IMG(20 * 1024), extraction: { engine: 'x' } }),
    ]);
    await store.ledgerRecordMany(C, [
      { seq: await seqOf('A'), attempts: 1, outcome: 'deferred' },
      { seq: await seqOf('C'), attempts: 3, outcome: 'failed' },
    ]);
    const current = await store.visualWaitingCount(C);
    // A second store on the same file, pre-repair view (flag not cached yet).
    await db.run(`DELETE FROM meta WHERE key = 'ledgerRekeyed'`);
    const legacy = openStore(db, deps);
    expect(await legacy.visualWaitingCount(C)).toBe(current);
  });

  it('a deferred row with attempts 0 (blocked) counts', async () => {
    await seed([file('A', IMG(20 * 1024))]);
    await store.ledgerRecordMany(C, [
      { seq: await seqOf('A'), attempts: 0, outcome: 'deferred' },
    ]);
    expect(await store.visualWaitingCount(C)).toBe(1);
  });

  const planOf = async (sql: string): Promise<string[]> =>
    (
      (await db.all(`EXPLAIN QUERY PLAN ${sql}`, [C])) as Array<{
        detail: string;
      }>
    ).map((r) => r.detail);

  it('the deferred branch is driven by work_ledger_active and the PKs', async () => {
    const plan = await planOf(VISUAL_WAITING_DEFERRED_SQL);
    expect(plan.some((d) => /work_ledger_active/.test(d))).toBe(true);
    expect(plan.some((d) => /^SCAN /.test(d))).toBe(false);
    expect(plan.some((d) => /SEARCH c USING INTEGER PRIMARY KEY/.test(d))).toBe(
      true,
    );
    expect(plan.some((d) => /SEARCH documents /.test(d))).toBe(true);
  });

  it('the current-seq branch uses docs_pending_visual and the ledger PK', async () => {
    const plan = await planOf(VISUAL_WAITING_CURRENT_SQL);
    expect(plan.some((d) => /docs_pending_visual/.test(d))).toBe(true);
    expect(
      plan.some((d) =>
        /SEARCH l USING INDEX sqlite_autoindex_work_ledger_1 \(consumer=\? AND seq=\?\)/.test(
          d,
        ),
      ),
    ).toBe(true);
    // The driving table is a full walk of the PARTIAL index (SCAN ... USING
    // COVERING INDEX docs_pending_visual) — only a SCAN of anything else
    // would be a corpus walk.
    expect(
      plan.filter((d) => /^SCAN /.test(d) && !/docs_pending_visual/.test(d)),
    ).toEqual([]);
  });

  it('the vision identity yields the consumer the ledger uses', () => {
    expect(`worker:${VISION_WORKER.name}:v${VISION_WORKER.version}`).toBe(C);
  });
});
