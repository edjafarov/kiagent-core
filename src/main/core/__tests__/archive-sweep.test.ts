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
});
