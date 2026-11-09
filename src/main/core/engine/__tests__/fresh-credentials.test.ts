/** @jest-environment node */
import type { Credentials } from '@shared/contracts';
import { SourceAuthError, sourceErrorCode } from '@shared/source-errors';
import { freshCredentials } from '../fresh-credentials';

const at = (msFromNow: number) => new Date(Date.now() + msFromNow).toISOString();

const run = (creds: Credentials, refresh: () => Promise<Credentials | null>) => {
  const saved: Credentials[] = [];
  const warn = jest.fn();
  const p = freshCredentials({
    vault: {
      load: async () => creds,
      save: async (_a, c) => void saved.push(c),
    },
    account: 'a1' as never,
    refresh,
    warn,
  });
  return { p, saved, warn };
};

const netDown = () => Promise.reject(new TypeError('fetch failed'));

describe('freshCredentials when the refresh fails', () => {
  it('an expired token and a network failure: a transient (uncoded) error, never the stale token', async () => {
    const { p, warn } = run({ accessToken: 'old', expiresAt: at(-60_000) }, netDown);
    const err = await p.then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect(String(err)).toMatch(/token has expired/);
    expect(sourceErrorCode(err)).toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });

  it('a token still valid for a little while: kept, with a warning', async () => {
    const { p, warn } = run({ accessToken: 'old', expiresAt: at(30_000) }, netDown);
    await expect(p).resolves.toMatchObject({ accessToken: 'old' });
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/token refresh failed/));
  });

  it('a revoked grant still propagates as auth', async () => {
    const { p } = run({ accessToken: 'old', expiresAt: at(-60_000) }, () =>
      Promise.reject(new SourceAuthError('invalid_grant')),
    );
    await expect(p).rejects.toMatchObject({ code: 'auth' });
  });

  it('a successful refresh is saved and returned', async () => {
    const fresh = { accessToken: 'new', expiresAt: at(3_600_000) };
    const { p, saved } = run({ accessToken: 'old', expiresAt: at(-60_000) }, async () => fresh);
    await expect(p).resolves.toBe(fresh);
    expect(saved).toEqual([fresh]);
  });
});
