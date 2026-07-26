import { signConfirmToken, verifyConfirmToken } from '../tokens';

const SECRET = Buffer.alloc(32, 7);
const ID = '0198f4a2-1111-7000-8000-abcdefabcdef';

describe('confirm tokens', () => {
  it('round-trips a valid token', () => {
    const t = signConfirmToken(SECRET, ID, 2_000_000);
    expect(verifyConfirmToken(SECRET, t, 1_000_000)).toEqual({
      draftId: ID,
      expiresAtMs: 2_000_000,
    });
  });

  it('rejects an expired token', () => {
    const t = signConfirmToken(SECRET, ID, 2_000_000);
    expect(verifyConfirmToken(SECRET, t, 2_000_001)).toBeNull();
  });

  it('rejects a tampered draft id', () => {
    const t = signConfirmToken(SECRET, ID, 2_000_000);
    const other = t.replace(ID, ID.replace('1111', '2222'));
    expect(verifyConfirmToken(SECRET, other, 1_000_000)).toBeNull();
  });

  it('rejects a token signed with a different secret', () => {
    const t = signConfirmToken(Buffer.alloc(32, 8), ID, 2_000_000);
    expect(verifyConfirmToken(SECRET, t, 1_000_000)).toBeNull();
  });

  it('rejects garbage without throwing', () => {
    expect(verifyConfirmToken(SECRET, 'not.a.token', 0)).toBeNull();
    expect(verifyConfirmToken(SECRET, '', 0)).toBeNull();
    expect(verifyConfirmToken(SECRET, 'a.b', 0)).toBeNull();
  });
});
