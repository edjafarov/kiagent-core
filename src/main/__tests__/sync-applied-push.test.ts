/** @jest-environment node */
import { wireSyncAppliedPush } from '../sync-applied-push';

const setup = () => {
  let cb: (tables: string[]) => void = () => undefined;
  const sent: string[] = [];
  const hint = jest.fn();
  wireSyncAppliedPush(
    { onApplied: (c) => void (cb = c) },
    { attentionHint: hint, broadcast: (channel) => void sent.push(channel) },
  );
  return { fire: (t: string[]) => cb(t), sent, hint };
};

describe('a delta applied on a follower refreshes the open pages', () => {
  it('attention tables hint the attention push', () => {
    const t = setup();
    t.fire(['attention_items']);
    t.fire(['attention_revisions']);
    expect(t.hint).toHaveBeenCalledTimes(2);
    expect(t.sent).toEqual([]);
  });

  it('outbox tells the outbox page, event_drafts the calendar-out page', () => {
    const t = setup();
    t.fire(['outbox']);
    t.fire(['event_drafts']);
    expect(t.sent).toEqual(['push:outbox-changed', 'push:calendar-out-changed']);
    expect(t.hint).not.toHaveBeenCalled();
  });

  it('one delta of several tables does each push once, and an unrelated one none', () => {
    const t = setup();
    t.fire(['documents', 'attention_items', 'attention_revisions', 'outbox', 'accounts']);
    expect(t.hint).toHaveBeenCalledTimes(1);
    expect(t.sent).toEqual(['push:outbox-changed']);
    const u = setup();
    u.fire(['documents', 'accounts', 'sync_epochs']);
    expect(u.hint).not.toHaveBeenCalled();
    expect(u.sent).toEqual([]);
  });
});

describe('a delta that touches accounts or documents reads the app state again', () => {
  const setupTimed = () => {
    let cb: (tables: string[]) => void = () => undefined;
    const timers: (() => void)[] = [];
    const reproject = jest.fn();
    wireSyncAppliedPush(
      { onApplied: (c) => void (cb = c) },
      { attentionHint: () => undefined, broadcast: () => undefined, reproject },
      { setTimeout: (fn) => void timers.push(fn) },
    );
    const tick = () => timers.shift()?.();
    return { fire: (t: string[]) => cb(t), reproject, tick, timers };
  };

  it('accounts and documents read it again; other tables do not', () => {
    const t = setupTimed();
    t.fire(['outbox', 'sync_epochs']);
    expect(t.reproject).not.toHaveBeenCalled();
    t.fire(['accounts']);
    expect(t.reproject).toHaveBeenCalledTimes(1);
    t.tick();
    t.fire(['documents']);
    expect(t.reproject).toHaveBeenCalledTimes(2);
  });

  it('deltas inside the window fold into one read at its end', () => {
    const t = setupTimed();
    t.fire(['documents']);
    t.fire(['documents']);
    t.fire(['accounts']);
    expect(t.reproject).toHaveBeenCalledTimes(1);
    t.tick();
    expect(t.reproject).toHaveBeenCalledTimes(2);
    // Nothing new during the second window: no third read.
    t.tick();
    expect(t.reproject).toHaveBeenCalledTimes(2);
    expect(t.timers).toHaveLength(0);
  });
});
