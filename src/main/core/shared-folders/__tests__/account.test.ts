import { closeDevices, device, withRoots } from './helpers/device';

afterEach(closeDevices);

const make = () => {
  const calls: string[] = [];
  return {
    calls,
    ensureAccount: async () => {
      calls.push('ensure');
    },
  };
};

it('the leader creates the account once, when a root is set and there is none', async () => {
  const a = make();
  const d = await device('leader', { ensureAccount: a.ensureAccount });
  await d.svc.settled();
  expect(a.calls).toEqual([]); // no root yet
  await withRoots(d);
  await d.svc.settled();
  expect(a.calls).toEqual(['ensure']);
});

it('creating it again is not asked for once an account exists', async () => {
  const a = make();
  const d = await device('leader', { ensureAccount: a.ensureAccount });
  await d.db.run(
    `INSERT INTO accounts(id, source, identifier, config, status, created_at)
     VALUES('acct', 'shared-folder', 'shared', '{}', 'connecting', 'now')`,
  );
  await withRoots(d);
  d.svc.kick();
  await d.svc.settled();
  expect(a.calls).toEqual([]);
});

it('a copy never creates it; the leader\'s account arrives with the copied rows', async () => {
  const a = make();
  const d = await device('copy', { ensureAccount: a.ensureAccount });
  await withRoots(d);
  d.svc.kick();
  await d.svc.settled();
  expect(a.calls).toEqual([]);
});

it('a fenced device (waiting for the lease) creates nothing', async () => {
  const a = make();
  const d = await device('fenced', { ensureAccount: a.ensureAccount });
  await withRoots(d);
  await d.svc.settled();
  expect(a.calls).toEqual([]);
});

it('a copy that becomes the leader creates it', async () => {
  const a = make();
  const d = await device('copy', { ensureAccount: a.ensureAccount });
  await withRoots(d);
  d.sync.set('leader');
  await new Promise((r) => setTimeout(r, 20));
  await d.svc.settled();
  expect(a.calls).toEqual(['ensure']);
});

it('a failure to create it is logged and does not stop the scan', async () => {
  const d = await device('leader', {
    ensureAccount: async () => {
      throw new Error('store is busy');
    },
  });
  await withRoots(d);
  await d.svc.settled();
  expect(d.logs.some((l) => l.includes('store is busy'))).toBe(true);
  expect(d.svc.mode()).toBe('leader');
});
