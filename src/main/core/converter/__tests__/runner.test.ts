/** @jest-environment node */
import type { RunnerChild } from '../../mcp/sql-runner';
import {
  ConverterCrashedError,
  ConverterTimeoutError,
  ConverterUnavailableError,
} from '../converter';
import { createConverterRunner } from '../runner';

class FakeChild implements RunnerChild {
  readonly pid = 4242;

  sent: Array<{ id: number; op: string; bytes: Uint8Array }> = [];

  killed: string[] = [];

  private msg?: (m: unknown) => void;

  private exit?: (code: number | null) => void;

  /** Signals this fake dies on. [] = ignores every signal. */
  dieOn: string[] = ['SIGTERM', 'SIGKILL'];

  send(m: unknown) {
    this.sent.push(m as never);
  }

  onMessage(cb: (m: unknown) => void) {
    this.msg = cb;
  }

  onExit(cb: (code: number | null) => void) {
    this.exit = cb;
  }

  kill(sig: 'SIGTERM' | 'SIGKILL') {
    this.killed.push(sig);
    if (this.dieOn.includes(sig)) queueMicrotask(() => this.exit?.(null));
  }

  ready() {
    this.msg?.({ t: 'ready' });
  }

  reply(id: number, result: unknown) {
    this.msg?.({ id, ok: true, result });
  }

  fail(id: number, name: string, message: string) {
    this.msg?.({ id, ok: false, name, message });
  }

  crash(code = 1) {
    this.exit?.(code);
  }
}

const until = async (cond: () => boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('condition not met in time');
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 5));
  }
};
const settle = <T>(p: Promise<T>) =>
  p.then(
    (v) => ({ ok: true as const, v }),
    (e: Error) => ({ ok: false as const, e }),
  );
const B = (n: number) => new Uint8Array(n);

function setup(
  over: Partial<Parameters<typeof createConverterRunner>[0]> = {},
) {
  const children: FakeChild[] = [];
  const runner = createConverterRunner({
    spawn: () => {
      const c = new FakeChild();
      children.push(c);
      queueMicrotask(() => c.ready());
      return c;
    },
    timeoutMs: 200,
    idleMs: 60_000,
    termGraceMs: 20,
    killGraceMs: 50,
    ...over,
  });
  return { runner, children };
}

afterEach(() => jest.restoreAllMocks());

it('runs one job at a time and resolves each result', async () => {
  const { runner, children } = setup();
  const a = runner.parsePdfPages(B(1));
  const b = runner.parsePdfPages(B(1));
  await until(() => children[0]?.sent.length === 1);
  expect(children[0].sent).toHaveLength(1); // b waits for a
  children[0].reply(children[0].sent[0].id, ['p1']);
  await expect(a).resolves.toEqual(['p1']);
  await until(() => children[0].sent.length === 2);
  children[0].reply(children[0].sent[1].id, ['p2']);
  await expect(b).resolves.toEqual(['p2']);
  expect(runner.stats().jobs).toBe(2);
  await runner.stop();
});

it('a crash fails only the active job; a queued job succeeds on the respawned child', async () => {
  const { runner, children } = setup();
  const active = settle(runner.parsePdfPages(B(1)));
  const queued = runner.parsePdfPages(B(1));
  await until(() => children[0]?.sent.length === 1);
  children[0].crash(139);
  const r = await active;
  expect(r.ok).toBe(false);
  expect((r as { e: Error }).e).toBeInstanceOf(ConverterCrashedError);
  await until(() => children[1]?.sent.length === 1);
  children[1].reply(children[1].sent[0].id, ['ok']);
  await expect(queued).resolves.toEqual(['ok']);
  expect(runner.stats().crashes).toBe(1);
  await runner.stop();
});

it('a timeout rejects ConverterTimeoutError, escalates SIGTERM → SIGKILL, respawns for the next job', async () => {
  const { runner, children } = setup();
  const slow = settle(runner.parsePdfPages(B(1)));
  const next = runner.parsePdfPages(B(1));
  await until(() => children[0]?.sent.length === 1);
  children[0].dieOn = ['SIGKILL']; // ignores SIGTERM like a busy parser
  const r = await slow;
  expect((r as { e: Error }).e).toBeInstanceOf(ConverterTimeoutError);
  await until(() => children[0].killed.join() === 'SIGTERM,SIGKILL');
  await until(() => children[1]?.sent.length === 1);
  children[1].reply(children[1].sent[0].id, ['fine']);
  await expect(next).resolves.toEqual(['fine']);
  expect(runner.stats().timeouts).toBe(1);
  await runner.stop();
});

it('a spawn failure is transient: queued jobs reject ConverterUnavailableError and spawning backs off', async () => {
  let spawns = 0;
  const runner = createConverterRunner({
    spawn: () => {
      spawns += 1;
      throw new Error('ENOENT worker.js');
    },
    timeoutMs: 200,
    spawnBackoffMs: 60_000,
  });
  await expect(runner.parsePdfPages(B(1))).rejects.toBeInstanceOf(
    ConverterUnavailableError,
  );
  // Inside the backoff: rejected at once, no respawn per document.
  await expect(runner.parsePdfPages(B(1))).rejects.toBeInstanceOf(
    ConverterUnavailableError,
  );
  expect(spawns).toBe(1);
  await runner.stop();
});

it('a child that exits before ready is unavailable, not a crash', async () => {
  const runner = createConverterRunner({
    spawn: () => {
      const c = new FakeChild();
      queueMicrotask(() => c.crash(1));
      return c;
    },
    timeoutMs: 200,
  });
  await expect(runner.parsePdfPages(B(1))).rejects.toBeInstanceOf(
    ConverterUnavailableError,
  );
  expect(runner.stats().crashes).toBe(0);
  await runner.stop();
});

it('abort: a queued job is removed, an active one kills the child; both reject AbortError, neither is a crash', async () => {
  const { runner, children } = setup();
  const acA = new AbortController();
  const acB = new AbortController();
  const a = settle(runner.parsePdfPages(B(1), acA.signal));
  const b = settle(runner.parsePdfPages(B(1), acB.signal));
  await until(() => children[0]?.sent.length === 1);
  acB.abort(); // queued
  expect(((await b) as { e: Error }).e.name).toBe('AbortError');
  acA.abort(); // active
  expect(((await a) as { e: Error }).e.name).toBe('AbortError');
  await until(() => children[0].killed.includes('SIGTERM'));
  expect(runner.stats()).toMatchObject({ cancels: 2, crashes: 0 });
  await runner.stop();
});

it('the queue blocks at the byte bound; an oversize job is admitted into an empty queue', async () => {
  const { runner, children } = setup({ maxQueuedBytes: 10 });
  const big = runner.parsePdfPages(B(25)); // > bound, queue empty → admitted
  const first = runner.parsePdfPages(B(4));
  let secondStarted = false;
  const second = runner.parsePdfPages(B(4)).then((v) => {
    secondStarted = true;
    return v;
  });
  await until(() => children[0]?.sent.length === 1);
  expect(runner.stats().queuedBytes).toBe(25); // first/second wait for space
  children[0].reply(children[0].sent[0].id, ['big']);
  await big;
  await until(() => children[0].sent.length === 2);
  children[0].reply(children[0].sent[1].id, ['1']);
  await first;
  await until(() => children[0].sent.length === 3);
  children[0].reply(children[0].sent[2].id, ['2']);
  await second;
  expect(secondStarted).toBe(true);
  await runner.stop();
});

it('capacity is reserved atomically: simultaneous submits and several waiters never overshoot the bound', async () => {
  const { runner, children } = setup({ maxQueuedBytes: 10 });
  // Three 4-byte jobs in ONE tick: only two fit (8 ≤ 10), the third waits.
  const a = runner.parsePdfPages(B(4));
  const b = runner.parsePdfPages(B(4));
  const c = runner.parsePdfPages(B(4));
  const d = runner.parsePdfPages(B(4));
  await until(() => children[0]?.sent.length === 1);
  expect(runner.stats().queuedBytes).toBe(8);
  // a finishes: exactly ONE waiter (c) is granted, d keeps waiting.
  children[0].reply(children[0].sent[0].id, []);
  await a;
  await until(() => children[0].sent.length === 2);
  expect(runner.stats().queuedBytes).toBe(8);
  expect(runner.stats().queued).toBe(1); // c queued, b active, d waiting
  for (let i = 1; i < 4; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await until(() => children[0].sent.length === i + 1);
    children[0].reply(children[0].sent[i].id, []);
    expect(runner.stats().queuedBytes).toBeLessThanOrEqual(10);
  }
  await Promise.all([b, c, d]);
  expect(runner.stats().queuedBytes).toBe(0);
  await runner.stop();
});

it('an abort between the capacity grant and the enqueue returns the reservation', async () => {
  const { runner, children } = setup({ maxQueuedBytes: 10 });
  const hold = runner.parsePdfPages(B(8));
  const ac = new AbortController();
  const waiting = settle(runner.parsePdfPages(B(8), ac.signal));
  await until(() => children[0]?.sent.length === 1);
  // The reply settles `hold` and grants the waiter synchronously; the abort
  // lands before submit()'s continuation runs.
  children[0].reply(children[0].sent[0].id, []);
  ac.abort();
  expect(((await waiting) as { e: Error }).e.name).toBe('AbortError');
  await hold;
  expect(runner.stats().queuedBytes).toBe(0);
  expect(children[0].sent).toHaveLength(1);
  await runner.stop();
});

it('a stop between the capacity grant and the enqueue rejects unavailable and leaves nothing queued', async () => {
  const { runner, children } = setup({ maxQueuedBytes: 10 });
  const hold = settle(runner.parsePdfPages(B(8)));
  const waiting = settle(runner.parsePdfPages(B(8)));
  await until(() => children[0]?.sent.length === 1);
  children[0].reply(children[0].sent[0].id, []);
  const stopped = runner.stop(); // same tick as the grant
  expect(((await waiting) as { e: Error }).e).toBeInstanceOf(
    ConverterUnavailableError,
  );
  await hold;
  await stopped;
  expect(runner.stats()).toMatchObject({ queuedBytes: 0, queued: 0 });
  expect(children[0].sent).toHaveLength(1);
});

it('abort while waiting for queue space rejects AbortError', async () => {
  const { runner, children } = setup({ maxQueuedBytes: 10 });
  const hold = runner.parsePdfPages(B(8));
  const ac = new AbortController();
  const waiting = settle(runner.parsePdfPages(B(8), ac.signal));
  await until(() => children[0]?.sent.length === 1);
  ac.abort();
  expect(((await waiting) as { e: Error }).e.name).toBe('AbortError');
  children[0].reply(children[0].sent[0].id, []);
  await hold;
  await runner.stop();
});

it('exits after idleMs with nothing to do', async () => {
  const { runner, children } = setup({ idleMs: 30 });
  const p = runner.parsePdfPages(B(1));
  await until(() => children[0]?.sent.length === 1);
  children[0].reply(children[0].sent[0].id, []);
  await p;
  await until(() => children[0].killed.includes('SIGTERM'), 1000);
  expect(runner.stats().state).toBe('none');
  await runner.stop();
});

it('a parser error rejects with the child’s name and message; the child stays up', async () => {
  const { runner, children } = setup();
  const p = runner.parseDetailed(B(1), 'application/pdf', 'x.pdf');
  await until(() => children[0]?.sent.length === 1);
  children[0].fail(children[0].sent[0].id, 'TypeError', 'bad XRef entry');
  await expect(p).rejects.toThrow('bad XRef entry');
  await expect(p).rejects.toHaveProperty('name', 'TypeError');
  expect(children[0].killed).toEqual([]);
  await runner.stop();
});
