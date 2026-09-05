import fs from 'fs';
import path from 'path';

import type { Cadence, CommitBatch } from '@shared/contracts';

import {
  ARCHIVE_RETENTION_DAYS,
  ARCHIVE_SWEEP_CADENCE,
  ARCHIVE_SWEEP_JOB_ID,
  archiveCutoff,
  registerArchiveSweep,
} from '../boot';

function harness(now: string) {
  const commits: CommitBatch[] = [];
  const logged: Array<[string, string, string]> = [];
  let job: { cadence: Cadence; run: () => Promise<void> } | null = null;
  registerArchiveSweep({
    store: {
      commit: async (batch: CommitBatch) => {
        commits.push(batch);
        return 0;
      },
    },
    scheduler: {
      register: async (id, cadence, run) => {
        if (id === ARCHIVE_SWEEP_JOB_ID) job = { cadence, run };
      },
    },
    logs: {
      log: (scope, level, msg) => {
        logged.push([scope, level, msg]);
      },
    },
    now: () => new Date(now),
  });
  return { commits, logged, job: () => job };
}

describe('archive sweep', () => {
  it('registers a recurring job — without it nothing ever reclaims', () => {
    // The whole point of this module: `purgeArchived` was implemented, tested
    // and documented as the "archived → gone" hop, but had no production
    // caller, so archived rows and their FTS entries lived forever.
    const h = harness('2026-04-01T00:00:00.000Z');
    expect(h.job()).not.toBeNull();
    expect(h.job()!.cadence).toEqual(ARCHIVE_SWEEP_CADENCE);
    expect(h.job()!.cadence).not.toBe('manual');
  });

  it('purges at the retention boundary and nothing newer', async () => {
    const h = harness('2026-04-01T00:00:00.000Z');
    await h.job()!.run();

    expect(h.commits).toEqual([
      { purgeArchived: { before: '2026-03-02T00:00:00.000Z' } },
    ]);
    // 30 days back to the millisecond — the cutoff is the only thing standing
    // between a mis-attributed scope root and permanently destroyed documents.
    const at = new Date('2026-04-01T00:00:00.000Z');
    expect(
      (at.getTime() - new Date(archiveCutoff(at)).getTime()) / 86_400_000,
    ).toBe(ARCHIVE_RETENTION_DAYS);
  });

  it('says what it is about to destroy before destroying it', async () => {
    const h = harness('2026-04-01T00:00:00.000Z');
    await h.job()!.run();
    expect(h.logged).toEqual([
      [
        'maintenance',
        'info',
        'purging documents archived before 2026-03-02T00:00:00.000Z',
      ],
    ]);
  });

  it('is actually called from bootCore', () => {
    // The one line that makes any of this run, and the only one no behavioural
    // test can reach: bootCore needs a real DB worker. Delete the call and
    // every other test here stays green while the sweep silently never fires.
    // Pinned by source text, the same instrument `source-registry.test.ts`
    // and `apply-overlay.test.mjs` use for wiring that tests cannot execute.
    const src = fs.readFileSync(path.join(__dirname, '..', 'boot.ts'), 'utf8');
    const body = src.slice(src.indexOf('export async function bootCore'));
    expect(body).toContain('registerArchiveSweep({');
  });
});
