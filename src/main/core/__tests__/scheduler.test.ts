import { createScheduler } from '../scheduler';

function setup() {
  const store = {
    scheduleUpsert: jest.fn(async () => {}),
    scheduleAll: jest.fn(async () => []),
    scheduleDelete: jest.fn(async () => {}),
  };
  const sched = createScheduler(
    store as never,
    () => ({ onBattery: false, thermal: 'nominal' }) as never,
    { log: jest.fn() } as never,
  );
  return sched;
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

describe('scheduler trigger coalescing (#145)', () => {
  it('a trigger while the job runs earns exactly one follow-up run', async () => {
    const sched = setup();
    let release!: () => void;
    const run = jest.fn(
      () =>
        new Promise<void>((res) => {
          release = res;
        }),
    );
    await sched.register('worker:vision', 'manual', run);
    const first = sched.trigger('worker:vision');
    await flush();
    expect(run).toHaveBeenCalledTimes(1);
    await sched.trigger('worker:vision');
    release();
    await flush();
    expect(run).toHaveBeenCalledTimes(2);
    release();
    await first;
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('many triggers during one run still coalesce into a single follow-up', async () => {
    const sched = setup();
    let release!: () => void;
    const run = jest.fn(
      () =>
        new Promise<void>((res) => {
          release = res;
        }),
    );
    await sched.register('worker:audio', 'manual', run);
    const first = sched.trigger('worker:audio');
    await flush();
    await sched.trigger('worker:audio');
    await sched.trigger('worker:audio');
    await sched.trigger('worker:audio');
    release();
    await flush();
    release();
    await first;
    expect(run).toHaveBeenCalledTimes(2);
  });
});
