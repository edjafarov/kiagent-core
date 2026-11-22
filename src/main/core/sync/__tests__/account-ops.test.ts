import { accountKey, accountKeyOf, createAccountOps } from '../account-ops';

const gate = () => {
  let open!: () => void;
  const p = new Promise<void>((r) => {
    open = r;
  });
  return { p, open };
};
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('account operations on the leader', () => {
  it('runs operations with one key in order, also after a failure', async () => {
    const ops = createAccountOps({ now: () => 0 });
    const order: string[] = [];
    const g = gate();
    const a = ops.run(null, 'k', async () => {
      order.push('a:start');
      await g.p;
      order.push('a:end');
      throw new Error('a failed');
    });
    const b = ops.run(null, 'k', async () => {
      order.push('b');
      return 2;
    });
    await tick();
    expect(order).toEqual(['a:start']);
    g.open();
    await expect(a).rejects.toThrow('a failed');
    await expect(b).resolves.toBe(2);
    expect(order).toEqual(['a:start', 'a:end', 'b']);
  });

  it('lets different keys overlap', async () => {
    const ops = createAccountOps({ now: () => 0 });
    const g = gate();
    const a = ops.run(null, 'k1', async () => {
      await g.p;
      return 1;
    });
    await expect(ops.run(null, 'k2', async () => 2)).resolves.toBe(2);
    g.open();
    await expect(a).resolves.toBe(1);
  });

  it('answers a repeated operation id from the first run', async () => {
    const ops = createAccountOps({ now: () => 0 });
    let runs = 0;
    const fn = async () => {
      runs += 1;
      return { n: runs };
    };
    const first = await ops.run('op1', 'k', fn);
    const again = await ops.run('op1', 'k', fn);
    expect(again).toBe(first);
    expect(runs).toBe(1);
  });

  it('a repeat that arrives while the first still runs waits for it', async () => {
    const ops = createAccountOps({ now: () => 0 });
    const g = gate();
    let runs = 0;
    const fn = async () => {
      runs += 1;
      await g.p;
      return 'done';
    };
    const a = ops.run('op1', 'k', fn);
    const b = ops.run('op1', 'k', fn);
    g.open();
    await expect(Promise.all([a, b])).resolves.toEqual(['done', 'done']);
    expect(runs).toBe(1);
  });

  it('repeats a failure too, without running again', async () => {
    const ops = createAccountOps({ now: () => 0 });
    let runs = 0;
    const fn = async () => {
      runs += 1;
      throw new Error('refused');
    };
    await expect(ops.run('op1', 'k', fn)).rejects.toThrow('refused');
    await expect(ops.run('op1', 'k', fn)).rejects.toThrow('refused');
    expect(runs).toBe(1);
  });

  it('never caches an operation without an id', async () => {
    const ops = createAccountOps({ now: () => 0 });
    let runs = 0;
    const fn = async () => {
      runs += 1;
    };
    await ops.run(null, 'k', fn);
    await ops.run(null, 'k', fn);
    expect(runs).toBe(2);
  });

  it('forgets the oldest result past the cap', async () => {
    const ops = createAccountOps({ now: () => 0, cap: 2 });
    let runs = 0;
    const fn = async () => {
      runs += 1;
    };
    await ops.run('a', 'k', fn);
    await ops.run('b', 'k', fn);
    await ops.run('c', 'k', fn);
    await ops.run('b', 'k', fn);
    expect(runs).toBe(3);
    await ops.run('a', 'k', fn);
    expect(runs).toBe(4);
  });

  it('forgets a result after its time', async () => {
    let now = 0;
    const ops = createAccountOps({ now: () => now, ttlMs: 1000 });
    let runs = 0;
    const fn = async () => {
      runs += 1;
    };
    await ops.run('a', 'k', fn);
    now = 999;
    await ops.run('a', 'k', fn);
    expect(runs).toBe(1);
    now = 1001;
    await ops.run('a', 'k', fn);
    expect(runs).toBe(2);
  });

  it('once runs a known operation a single time, with no queue', async () => {
    const ops = createAccountOps({ now: () => 0 });
    let runs = 0;
    const fn = async () => {
      runs += 1;
      return runs;
    };
    await expect(ops.once('o', fn)).resolves.toBe(1);
    await expect(ops.once('o', fn)).resolves.toBe(1);
    expect(runs).toBe(1);
  });

  it('a forgotten operation runs again', async () => {
    const ops = createAccountOps({ now: () => 0 });
    let runs = 0;
    const fn = async () => {
      runs += 1;
    };
    await ops.once('o', fn);
    ops.forget('o');
    await ops.once('o', fn);
    expect(runs).toBe(2);
  });

  it('an account has one key, by id or by what a connect creates', async () => {
    const row = { source: 'gmail', identifier: 'me@example.com' };
    await expect(accountKeyOf(async () => row, 'acc-1')).resolves.toBe(
      accountKey('gmail', 'me@example.com'),
    );
    await expect(accountKeyOf(async () => null, 'acc-1')).resolves.toBe(
      'id:acc-1',
    );
  });
});
