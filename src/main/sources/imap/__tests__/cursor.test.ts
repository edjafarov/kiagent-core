import { advanceCursor, chunk, emptyCursor, planMailboxSync } from '../cursor';
import type { ImapCursor } from '../types';

describe('chunk', () => {
  it('splits into fixed-size groups, last group short', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it('returns one group when size >= length', () => {
    expect(chunk([1, 2], 50)).toEqual([[1, 2]]);
  });

  it('returns [] for an empty input', () => {
    expect(chunk([], 50)).toEqual([]);
  });

  it('throws for a non-positive size', () => {
    expect(() => chunk([1], 0)).toThrow();
  });
});

describe('planMailboxSync', () => {
  it('fresh mailbox (no prior cursor): fetch every present UID from 0', () => {
    const plan = planMailboxSync(undefined, 111, [3, 1, 2]);
    expect(plan).toEqual({ reset: false, uidsToFetch: [1, 2, 3] });
  });

  it('steady state: only UIDs beyond lastUid, same UIDVALIDITY', () => {
    const prev = { uidValidity: '111', lastUid: 10 };
    const plan = planMailboxSync(prev, 111, [8, 9, 10, 11, 12]);
    expect(plan).toEqual({ reset: false, uidsToFetch: [11, 12] });
  });

  it('steady state with nothing new yields an empty fetch list', () => {
    const prev = { uidValidity: '111', lastUid: 10 };
    const plan = planMailboxSync(prev, 111, [8, 9, 10]);
    expect(plan).toEqual({ reset: false, uidsToFetch: [] });
  });

  it('UIDVALIDITY change forces a reset: resume from 0 regardless of lastUid', () => {
    const prev = { uidValidity: '111', lastUid: 10 };
    const plan = planMailboxSync(prev, 222, [1, 2, 3]);
    expect(plan).toEqual({ reset: true, uidsToFetch: [1, 2, 3] });
  });
});

describe('advanceCursor / emptyCursor', () => {
  it('emptyCursor starts with no mailboxes', () => {
    expect(emptyCursor()).toEqual({ mailboxes: {} });
  });

  it('adds/replaces only the named mailbox, preserving others', () => {
    const cur: ImapCursor = { mailboxes: { INBOX: { uidValidity: '1', lastUid: 5 } } };
    const next = advanceCursor(cur, 'Sent', 42, 7);
    expect(next).toEqual({
      mailboxes: {
        INBOX: { uidValidity: '1', lastUid: 5 },
        Sent: { uidValidity: '42', lastUid: 7 },
      },
    });
    // original untouched
    expect(cur.mailboxes.Sent).toBeUndefined();
  });
});
