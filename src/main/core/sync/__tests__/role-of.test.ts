import type { LeaseSnapshot } from '@shared/contracts';

import {
  canWrite,
  phaseOf,
  roleOf,
  SyncEpochBehind,
  SyncHeadPending,
  SyncNotLeader,
  type SyncPhase,
} from '../role';

const lease = (over: Partial<LeaseSnapshot>): LeaseSnapshot => ({
  isMaster: false,
  reason: 'holder',
  multiDevice: false,
  approved: true,
  holder: null,
  epoch: 1,
  priorRenewedAt: null,
  ...over,
});

const base = {
  role: 'normal' as const,
  joining: false,
  joined: false,
  tracking: false,
  fenced: false,
};

describe('phaseOf', () => {
  it.each([
    [
      'follower',
      { ...base, role: 'follower' as const, tracking: true, fenced: true },
      'follower',
    ],
    ['joining', { ...base, joining: true, tracking: true }, 'joining'],
    ['normal+tracking, not fenced', { ...base, tracking: true }, 'leader'],
    [
      'normal+tracking, fenced',
      { ...base, tracking: true, fenced: true },
      'leader-fenced',
    ],
    ['normal, not tracking', base, 'alone'],
    [
      'normal, not tracking, fenced flag ignored',
      { ...base, fenced: true },
      'alone',
    ],
  ])('%s', (_n, g, want) => {
    expect(phaseOf(g)).toBe(want);
  });
});

describe('canWrite', () => {
  it.each<[SyncPhase, boolean]>([
    ['alone', true],
    ['leader', true],
    ['joining', false],
    ['leader-fenced', false],
    ['follower', false],
  ])('%s -> %s', (p, want) => {
    expect(canWrite(p)).toBe(want);
  });
});

describe('roleOf (spec K2 table)', () => {
  const r = (leader: boolean, follower: boolean, reason: string) => ({
    leader,
    follower,
    reason,
  });
  it.each<[string, SyncPhase, LeaseSnapshot | null, ReturnType<typeof r>]>([
    ['follower, no lease', 'follower', null, r(false, true, 'follower-copy')],
    [
      'follower, lease',
      'follower',
      lease({ reason: 'not-signed-in', isMaster: true }),
      r(false, true, 'not-signed-in'),
    ],
    ['joining, no lease', 'joining', null, r(false, true, 'follower-copy')],
    [
      'joining, lease',
      'joining',
      lease({ reason: 'follower' }),
      r(false, true, 'follower'),
    ],
    [
      'leader-fenced, boot (no lease)',
      'leader-fenced',
      null,
      r(false, false, 'fenced-boot'),
    ],
    [
      'leader-fenced, promotion pending ack (isMaster)',
      'leader-fenced',
      lease({ isMaster: true, reason: 'holder', multiDevice: true }),
      r(false, false, 'holder'),
    ],
    [
      'leader-fenced, stepped down (!isMaster, multiDevice)',
      'leader-fenced',
      lease({ reason: 'fenced', multiDevice: true }),
      r(false, true, 'fenced'),
    ],
    [
      'leader-fenced, stepped down (!isMaster, single)',
      'leader-fenced',
      lease({ reason: 'fenced', multiDevice: false }),
      r(false, false, 'fenced'),
    ],
    ['leader, no lease', 'leader', null, r(true, false, 'solo')],
    [
      'leader, isMaster',
      'leader',
      lease({ isMaster: true, reason: 'holder' }),
      r(true, false, 'holder'),
    ],
    ['alone, no lease', 'alone', null, r(true, false, 'solo')],
    [
      'alone, isMaster',
      'alone',
      lease({ isMaster: true, reason: 'solo' }),
      r(true, false, 'solo'),
    ],
    [
      'alone, !isMaster (pending approval)',
      'alone',
      lease({ reason: 'pending-approval', multiDevice: true }),
      r(false, true, 'pending-approval'),
    ],
    [
      'alone, !isMaster, single device',
      'alone',
      lease({ reason: 'no-keystore', multiDevice: false }),
      r(false, false, 'no-keystore'),
    ],
  ])('%s', (_n, phase, l, want) => {
    expect(roleOf({ phase, lease: l })).toEqual(want);
  });
});

describe('sync errors', () => {
  it.each([
    [
      SyncEpochBehind,
      'a grant is never older than what this copy applied from',
    ],
    [SyncNotLeader, 'open() on a follower or a joining device'],
    [SyncHeadPending, "open('lease') while head_pending = 1"],
  ])('%p', (E, msg) => {
    const e = new E();
    expect(e).toBeInstanceOf(Error);
    expect(e.message).toBe(msg);
  });
});
