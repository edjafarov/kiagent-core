import {
  createSqlRunner,
  SQL_STILL_STOPPING,
  SQL_UNAVAILABLE,
  sqlStoppedMessage,
  type RunnerChild,
} from '../sql-runner';

function fakeChild(pid: number) {
  const msgCbs: Array<(m: unknown) => void> = [];
  const exitCbs: Array<(c: number | null) => void> = [];
  const sent: Array<{ id: number; sql: string }> = [];
  const kills: string[] = [];
  const child: RunnerChild = {
    pid,
    send: (m) => {
      sent.push(m as never);
    },
    onMessage: (cb) => {
      msgCbs.push(cb);
    },
    onExit: (cb) => {
      exitCbs.push(cb);
    },
    kill: (s) => {
      kills.push(s);
    },
  };
  return {
    child,
    sent,
    kills,
    say: (m: unknown) => msgCbs.forEach((cb) => cb(m)),
    exit: (code: number | null = 0) => exitCbs.forEach((cb) => cb(code)),
  };
}

function harness() {
  const children: Array<ReturnType<typeof fakeChild>> = [];
  const log = jest.fn();
  const spawn = jest.fn(() => {
    const c = fakeChild(1000 + children.length);
    children.push(c);
    return c.child;
  });
  const runner = createSqlRunner({
    spawn,
    timeoutMs: 10_000,
    idleMs: 300_000,
    log,
  });
  return { runner, children, spawn, log };
}

const reply = (id: number, rows: unknown[] = []) => ({
  id,
  ok: true,
  result: { rows, truncated: false },
  bytes: 10,
  execMs: 1,
});

describe('createSqlRunner', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('spawns on the first call, sends only after ready, serializes calls', async () => {
    const { runner, children, spawn } = harness();
    const p1 = runner.exec('SELECT 1');
    const p2 = runner.exec('SELECT 2');
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(runner.diagnostics().state).toBe('starting');
    expect(children[0].sent).toEqual([]);
    children[0].say({ t: 'ready' });
    expect(children[0].sent.map((s) => s.sql)).toEqual(['SELECT 1']);
    children[0].say(reply(1, [{ one: 1 }]));
    await expect(p1).resolves.toEqual({ rows: [{ one: 1 }], truncated: false });
    expect(children[0].sent.map((s) => s.sql)).toEqual([
      'SELECT 1',
      'SELECT 2',
    ]);
    children[0].say(reply(2));
    await p2;
    expect(runner.diagnostics().state).toBe('ready');
  });

  it('passes a SQL error message through unchanged', async () => {
    const { runner, children } = harness();
    const p = runner.exec('SELECT * FROM nope');
    children[0].say({ t: 'ready' });
    children[0].say({ id: 1, ok: false, message: 'no such table: nope' });
    await expect(p).rejects.toThrow('no such table: nope');
  });

  it('times out: message, SIGTERM, stopping state, retry message, fresh child afterwards', async () => {
    const { runner, children, spawn } = harness();
    const p1 = runner.exec('slow');
    children[0].say({ t: 'ready' });
    const rejected = await expect(p1).rejects.toThrow(
      sqlStoppedMessage(10_000),
    );
    await jest.advanceTimersByTimeAsync(10_000);
    await rejected;
    expect(sqlStoppedMessage(10_000)).toBe(
      'query_sql stopped after 10 s. Narrow it: filter by account or created_at, avoid LIKE over markdown, or use search.',
    );
    expect(runner.diagnostics()).toMatchObject({
      state: 'stopping',
      pid: 1000,
      timeouts: 1,
    });
    expect(children[0].kills).toEqual(['SIGTERM']);
    await expect(runner.exec('x')).rejects.toThrow(SQL_STILL_STOPPING);
    expect(SQL_STILL_STOPPING).toBe(
      'query_sql is still stopping the previous query. Try again in a few seconds.',
    );

    children[0].exit(null);
    expect(runner.diagnostics().state).toBe('none');
    const p2 = runner.exec('SELECT 2');
    expect(spawn).toHaveBeenCalledTimes(2);
    children[1].say({ t: 'ready' });
    children[1].say(reply(children[1].sent[0].id, [{ two: 2 }]));
    await expect(p2).resolves.toMatchObject({ rows: [{ two: 2 }] });
  });

  it('escalates to SIGKILL after 2 s of ignored SIGTERM', async () => {
    const { runner, children } = harness();
    const p = runner.exec('slow');
    children[0].say({ t: 'ready' });
    const rejected = await expect(p).rejects.toThrow(/stopped after/);
    await jest.advanceTimersByTimeAsync(10_000);
    await rejected;
    await jest.advanceTimersByTimeAsync(1_999);
    expect(children[0].kills).toEqual(['SIGTERM']);
    await jest.advanceTimersByTimeAsync(1);
    expect(children[0].kills).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('goes stuck when nothing exits 5 s after SIGKILL: never a second child; a late exit recovers', async () => {
    const { runner, children, spawn, log } = harness();
    const p = runner.exec('slow');
    children[0].say({ t: 'ready' });
    const rejected = await expect(p).rejects.toThrow(/stopped after/);
    await jest.advanceTimersByTimeAsync(10_000 + 2_000 + 5_000);
    await rejected;
    expect(runner.diagnostics().state).toBe('stuck');
    expect(log).toHaveBeenCalledWith(
      'error',
      expect.stringContaining('did not exit'),
    );
    await expect(runner.exec('x')).rejects.toThrow(SQL_UNAVAILABLE);
    expect(spawn).toHaveBeenCalledTimes(1);
    children[0].exit(null); // the OS finally reaped it
    expect(runner.diagnostics().state).toBe('none');
    const p2 = runner.exec('SELECT 3');
    expect(spawn).toHaveBeenCalledTimes(2);
    children[1].say({ t: 'ready' });
    children[1].say(reply(children[1].sent[0].id));
    await p2;
  });

  it("a waiting caller's 10 s starts when its own statement starts", async () => {
    const { runner, children } = harness();
    const p1 = runner.exec('a');
    const p2 = runner.exec('b');
    children[0].say({ t: 'ready' });
    await jest.advanceTimersByTimeAsync(9_000);
    children[0].say(reply(1));
    await p1;
    expect(children[0].sent.map((s) => s.sql)).toEqual(['a', 'b']);
    await jest.advanceTimersByTimeAsync(9_000); // 18 s since the call, 9 s since b started
    expect(runner.diagnostics().timeouts).toBe(0);
    const rejected = await expect(p2).rejects.toThrow(/stopped after/);
    await jest.advanceTimersByTimeAsync(1_000);
    await rejected;
    expect(runner.diagnostics().timeouts).toBe(1);
  });

  it('spawn failure: unavailable message, error logged, the next call retries the spawn', async () => {
    const { runner, children, spawn, log } = harness();
    spawn.mockImplementationOnce(() => {
      throw new Error('native module failed to load');
    });
    await expect(runner.exec('x')).rejects.toThrow(SQL_UNAVAILABLE);
    expect(log).toHaveBeenCalledWith(
      'error',
      expect.stringContaining('native module failed to load'),
    );
    const p = runner.exec('SELECT 1');
    expect(spawn).toHaveBeenCalledTimes(2);
    children[0].say({ t: 'ready' });
    children[0].say(reply(children[0].sent[0].id));
    await p;
  });

  it('an open-error from the child is unavailable and the child is stopped', async () => {
    const { runner, children } = harness();
    const p = runner.exec('x');
    const rejected = await expect(p).rejects.toThrow(SQL_UNAVAILABLE);
    children[0].say({ t: 'open-error', message: 'cannot load better-sqlite3' });
    await rejected;
    expect(children[0].kills).toEqual(['SIGTERM']);
  });

  it('an unexpected exit while a statement runs fails the caller and the next call spawns', async () => {
    const { runner, children, spawn } = harness();
    const p = runner.exec('x');
    children[0].say({ t: 'ready' });
    const rejected = await expect(p).rejects.toThrow(SQL_UNAVAILABLE);
    children[0].exit(137); // OOM-killed
    await rejected;
    expect(runner.diagnostics().state).toBe('none');
    void runner.exec('y').catch(() => {});
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it('kills an idle child after idleMs', async () => {
    const { runner, children } = harness();
    const p = runner.exec('SELECT 1');
    children[0].say({ t: 'ready' });
    children[0].say(reply(1));
    await p;
    await jest.advanceTimersByTimeAsync(299_999);
    expect(children[0].kills).toEqual([]);
    await jest.advanceTimersByTimeAsync(1);
    expect(children[0].kills).toEqual(['SIGTERM']);
    expect(runner.diagnostics().state).toBe('stopping');
    children[0].exit(0);
    expect(runner.diagnostics().state).toBe('none');
  });

  it('stop() kills the child, resolves once it exited, and refuses later calls', async () => {
    const { runner, children } = harness();
    const p = runner.exec('SELECT 1');
    children[0].say({ t: 'ready' });
    children[0].say(reply(1));
    await p;
    const stopped = runner.stop();
    expect(children[0].kills).toEqual(['SIGTERM']);
    children[0].exit(0);
    await stopped;
    await expect(runner.exec('x')).rejects.toThrow(SQL_UNAVAILABLE);
  });
});
