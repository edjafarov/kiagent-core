import { wireOutboxPush } from '../outbox-push';

/** Minimal `OutboxStore.onChange` stub: records listeners so a test can
 *  fire a change synchronously, and returns a real unsubscribe closure
 *  mirroring the store's own contract. */
function stubOutboxStore(): {
  store: { outbox: { onChange: (cb: () => void) => () => void } };
  fireChange: () => void;
} {
  const listeners: Array<() => void> = [];
  return {
    store: {
      outbox: {
        onChange: (cb: () => void) => {
          listeners.push(cb);
          return () => {
            const i = listeners.indexOf(cb);
            if (i >= 0) listeners.splice(i, 1);
          };
        },
      },
    },
    fireChange: () => {
      for (const cb of listeners) cb();
    },
  };
}

describe('wireOutboxPush', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('broadcasts once for a burst and again for a later change', () => {
    jest.useFakeTimers();
    const { store, fireChange } = stubOutboxStore();
    const broadcast = jest.fn();
    wireOutboxPush(store, broadcast);

    fireChange();
    fireChange();
    fireChange();
    jest.advanceTimersByTime(50);
    expect(broadcast).toHaveBeenCalledTimes(1);

    fireChange();
    jest.advanceTimersByTime(50);
    expect(broadcast).toHaveBeenCalledTimes(2);
  });

  it('broadcasts push:outbox-changed with no payload', () => {
    jest.useFakeTimers();
    const { store, fireChange } = stubOutboxStore();
    const broadcast = jest.fn();
    wireOutboxPush(store, broadcast);

    fireChange();
    jest.advanceTimersByTime(50);
    expect(broadcast).toHaveBeenCalledWith('push:outbox-changed', undefined);
  });

  it('does not broadcast when nothing changed', () => {
    jest.useFakeTimers();
    const { store } = stubOutboxStore();
    const broadcast = jest.fn();
    wireOutboxPush(store, broadcast);

    jest.advanceTimersByTime(1000);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('a change mid-window does not reset the timer (leading-edge scheduled)', () => {
    jest.useFakeTimers();
    const { store, fireChange } = stubOutboxStore();
    const broadcast = jest.fn();
    wireOutboxPush(store, broadcast);

    fireChange();
    jest.advanceTimersByTime(30);
    fireChange(); // inside the same window — must not push the deadline out
    jest.advanceTimersByTime(20);
    expect(broadcast).toHaveBeenCalledTimes(1);
  });

  it('unsubscribing stops future broadcasts', () => {
    jest.useFakeTimers();
    const { store, fireChange } = stubOutboxStore();
    const broadcast = jest.fn();
    const unsubscribe = wireOutboxPush(store, broadcast);

    unsubscribe();
    fireChange();
    jest.advanceTimersByTime(50);
    expect(broadcast).not.toHaveBeenCalled();
  });
});
