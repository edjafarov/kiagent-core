/** @jest-environment node */
import type { CoreStore } from '../../core/store/store';
import { SCHEDULE_TICK_MS, createOutboxScheduler } from '../scheduler';

describe('outbox scheduler', () => {
  const setup = (due: Array<{ id: string; sendAt: string }>) => {
    const sent: string[] = [];
    let release: () => void = () => {};
    const gate = { hold: false };
    const store = {
      outbox: { listDue: jest.fn(async () => due) },
    } as unknown as CoreStore;
    const service = {
      sendScheduled: jest.fn(async (id: string) => {
        if (gate.hold)
          await new Promise<void>((r) => {
            release = r;
          });
        if (id === 'boom') throw new Error('db closed');
        sent.push(id);
        return 'sent' as const;
      }),
    };
    let fire: () => void = () => {};
    const every = jest.fn((fn: () => void) => {
      fire = fn;
      return 1;
    });
    const cancel = jest.fn();
    const s = createOutboxScheduler({
      store,
      service,
      logSink: { log: () => {} },
      now: () => Date.parse('2026-10-20T10:00:00.000Z'),
      setInterval: every,
      clearInterval: cancel,
    });
    return {
      s,
      store,
      service,
      sent,
      gate,
      release: () => release(),
      fire: () => fire(),
      every,
      cancel,
    };
  };

  it('start ticks at once, then every 30 s; due rows go one at a time', async () => {
    const t = setup([
      { id: 'a', sendAt: '2026-10-20T09:59:00.000Z' },
      { id: 'b', sendAt: '2026-10-20T10:00:00.000Z' },
    ]);
    t.s.start();
    await t.s.tick();
    expect(t.store.outbox.listDue).toHaveBeenCalledWith(
      '2026-10-20T10:00:00.000Z',
    );
    expect(t.sent).toEqual(['a', 'b']);
    expect(t.every).toHaveBeenCalledWith(
      expect.any(Function),
      SCHEDULE_TICK_MS,
    );
    t.s.stop();
    expect(t.cancel).toHaveBeenCalled();
  });

  it('one failing row does not stop the others', async () => {
    const t = setup([
      { id: 'boom', sendAt: 'x' },
      { id: 'b', sendAt: 'y' },
    ]);
    await t.s.tick();
    expect(t.sent).toEqual(['b']);
  });

  it('a slow tick never stacks a second pass', async () => {
    const t = setup([{ id: 'a', sendAt: 'x' }]);
    t.gate.hold = true;
    const first = t.s.tick();
    const second = t.s.tick();
    expect(second).toBe(first);
    await new Promise((r) => setImmediate(r));
    t.release();
    await first;
    expect(t.service.sendScheduled).toHaveBeenCalledTimes(1);
  });
});
