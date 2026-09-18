import { wireAttentionPush } from '../push';

describe('wireAttentionPush', () => {
  afterEach(() => jest.useRealTimers());

  it('coalesces a burst into one attention invalidation', () => {
    jest.useFakeTimers();
    const broadcast = jest.fn();
    const changed = wireAttentionPush(broadcast);

    changed.hint();
    changed.hint();
    jest.advanceTimersByTime(50);

    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledWith('push:attention-changed', undefined);
  });

  it('S4c dispose cancels a pending and later hint without broadcasting', () => {
    jest.useFakeTimers();
    const broadcast = jest.fn();
    const push = wireAttentionPush(broadcast);

    push.hint();
    push.dispose();
    jest.advanceTimersByTime(50);
    push.hint();
    jest.advanceTimersByTime(50);

    expect(broadcast).not.toHaveBeenCalled();
  });
});
