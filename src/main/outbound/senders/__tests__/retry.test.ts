/**
 * withTransientRetry — minimal backoff wrapper for non-HTTP senders (SMTP).
 * Sleep is injected as a no-op seam so these tests never really wait.
 */
import { withTransientRetry } from '../retry';

describe('withTransientRetry', () => {
  it('retries a transient error twice then succeeds', async () => {
    let calls = 0;
    const sleep = jest.fn(async () => {});
    const fn = jest.fn(async () => {
      calls += 1;
      if (calls < 3) throw new Error('transient');
      return 'ok';
    });
    const result = await withTransientRetry(fn, {
      isTransient: () => true,
      sleep,
    });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('throws immediately on a non-transient error — no retry, no sleep', async () => {
    const sleep = jest.fn(async () => {});
    const fn = jest.fn(async () => {
      throw new Error('permanent');
    });
    await expect(
      withTransientRetry(fn, { isTransient: () => false, sleep }),
    ).rejects.toThrow('permanent');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledTimes(0);
  });

  it('gives up after the default cap (4 attempts) when always transient', async () => {
    const sleep = jest.fn(async () => {});
    const fn = jest.fn(async () => {
      throw new Error('always transient');
    });
    await expect(
      withTransientRetry(fn, { isTransient: () => true, sleep }),
    ).rejects.toThrow('always transient');
    expect(fn).toHaveBeenCalledTimes(4);
    expect(sleep).toHaveBeenCalledTimes(3);
  });

  it('honors a lower maxAttempts override', async () => {
    const sleep = jest.fn(async () => {});
    const fn = jest.fn(async () => {
      throw new Error('always transient');
    });
    await expect(
      withTransientRetry(fn, {
        isTransient: () => true,
        maxAttempts: 2,
        sleep,
      }),
    ).rejects.toThrow('always transient');
    expect(fn).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });
});
