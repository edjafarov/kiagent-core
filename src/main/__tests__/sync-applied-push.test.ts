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
