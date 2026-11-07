/** Plan Task 5: a follower reads and applies, and writes nothing else. */
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';

import { migrate } from '../../store/schema';
import { createWriteTx } from '../../store/write-tx';
import { followerLookup, gateEngine, readRoleSync, SyncReadOnly } from '../role';

let dir: string;
let db: Database.Database;
const tx = () =>
  createWriteTx(db, { detectLanguages: () => ['eng'], now: () => 'n' });
const follower = () => db.prepare(`UPDATE sync_state SET role='follower'`).run();
const joining = () => db.prepare(`UPDATE sync_state SET joining=1`).run();

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-role-'));
  db = new Database(path.join(dir, 'a.db'));
  migrate(db);
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const idle = (over: Record<string, unknown> = {}) => ({
  run: jest.fn(() => 'real'),
  attach: jest.fn(() => 'real'),
  rerunDeferred: jest.fn(async () => 'real'),
  connect: jest.fn(async () => 'real'),
  reconnect: jest.fn(async () => 'real'),
  applyScope: jest.fn(async () => 'real'),
  remove: jest.fn(async () => 'real'),
  pause: jest.fn(async () => 'real'),
  resume: jest.fn(async () => 'real'),
  updateConfig: jest.fn(async () => 'real'),
  setOption: jest.fn(async () => 'real'),
  ...over,
});

describe('engine gate', () => {
  const pull = (e: ReturnType<typeof idle>) =>
    (e.run as unknown as (a: unknown) => { status: string; stats(): Promise<{ pending: number }> })({});

  it('a follower runs no source pull and attaches no worker', async () => {
    const real = idle();
    const run = real.run;
    const e = { ...real };
    gateEngine(e as never, () => true);
    const h = pull(e);
    expect(h.status).toBe('paused');
    expect((await h.stats()).pending).toBe(0);
    (e.attach as unknown as (w: unknown) => unknown)({});
    expect(await (e.rerunDeferred as unknown as (w: unknown) => Promise<unknown>)({})).toBeUndefined();
    expect(run).not.toHaveBeenCalled();
    expect(real.attach).not.toHaveBeenCalled();
  });

  it('is read on every call: the same engine runs once the role flips', async () => {
    let ro = true;
    const e = idle();
    const realRun = e.run;
    gateEngine(e as never, () => ro);
    expect(pull(e).status).toBe('paused');
    expect(realRun).not.toHaveBeenCalled();
    ro = false;
    expect((pull(e) as unknown as { inner: unknown }).inner).toBe('real');
    expect(realRun).toHaveBeenCalledTimes(1);
    ro = true;
    expect(pull(e).status).toBe('paused');
  });

  it('attachHeld attaches exactly the workers held back, once, and the handle given earlier follows', async () => {
    let ro = true;
    const e = idle();
    const real = e.attach;
    const inner = { status: 'running', stats: async () => ({ pending: 3 }), stop: jest.fn(async () => undefined) };
    real.mockReturnValue(inner as never);
    const { attachHeld } = gateEngine(e as never, () => ro);
    const w1 = { id: 'w1' };
    const early = (e.attach as unknown as (w: unknown) => { status: string; stats(): Promise<{ pending: number }>; stop(): Promise<void> })(w1);
    expect(early.status).toBe('paused');
    expect(real).not.toHaveBeenCalled();
    ro = false;
    await attachHeld();
    await attachHeld();
    expect(real).toHaveBeenCalledTimes(1);
    expect(real).toHaveBeenCalledWith(w1);
    expect(early.status).toBe('running');
    expect((await early.stats()).pending).toBe(3);
    await early.stop();
    expect(inner.stop).toHaveBeenCalled();
  });

  it('a held worker stopped before promotion is not attached', async () => {
    let ro = true;
    const e = idle();
    const real = e.attach;
    const { attachHeld } = gateEngine(e as never, () => ro);
    const h = (e.attach as unknown as (w: unknown) => { stop(): Promise<void> })({});
    await h.stop();
    ro = false;
    await attachHeld();
    expect(real).not.toHaveBeenCalled();
  });

  it.each(['connect', 'reconnect', 'applyScope', 'remove', 'pause', 'resume', 'updateConfig', 'setOption'])(
    '%s rejects on a follower and runs after promotion',
    async (m) => {
      let ro = true;
      const real = idle();
      const spy = real[m as 'connect'];
      gateEngine(real as never, () => ro);
      await expect((real as never as Record<string, () => Promise<unknown>>)[m]()).rejects.toBeInstanceOf(SyncReadOnly);
      expect(spy).not.toHaveBeenCalled();
      ro = false;
      await expect((real as never as Record<string, () => Promise<unknown>>)[m]()).resolves.toBe('real');
    },
  );
});

describe('closeWriter', () => {
  const mk = () => {
    const stops: Array<() => void> = [];
    const mkInner = () => ({
      status: 'running',
      stats: async () => ({ pending: 0 }),
      stop: jest.fn(
        () => new Promise<void>((res) => stops.push(res)),
      ),
    });
    const inners: ReturnType<typeof mkInner>[] = [];
    const next = () => {
      const i = mkInner();
      inners.push(i);
      return i;
    };
    const e = idle({ run: jest.fn(next), attach: jest.fn(next) });
    return { e, inners, stops };
  };
  type Eng = { run(a: unknown): { stop(): Promise<void> }; attach(a: unknown): { stop(): Promise<void>; status: string } };
  const eng = (e: unknown) => e as Eng;

  it('closeWriter stops every live handle before awaiting any, holds unstopped attaches and drops runs', async () => {
    const { e, inners, stops } = mk();
    const real = { run: e.run, attach: e.attach };
    const g = gateEngine(e as never, () => false);
    eng(e).attach({ id: 'a1' });
    eng(e).attach({ id: 'a2' });
    eng(e).run({ id: 'r1' });
    const closing = g.closeWriter();
    expect(g.holding()).toBe(true);
    expect(inners).toHaveLength(3);
    for (const i of inners) expect(i.stop).toHaveBeenCalledTimes(1);
    expect(stops).toHaveLength(3);
    stops.forEach((r) => r());
    await closing;
    (real.attach as jest.Mock).mockClear();
    await g.attachHeld();
    expect(real.attach).toHaveBeenCalledTimes(2);
    expect(real.run).toHaveBeenCalledTimes(1);
    expect(g.holding()).toBe(false);
  });

  it('a run that ended on its own is not stopped by a later closeWriter', async () => {
    const { e, inners, stops } = mk();
    const real = { run: e.run, attach: e.attach };
    const g = gateEngine(e as never, () => false);
    eng(e).run({ id: 'r1' });
    eng(e).run({ id: 'r1' }); // the cadence re-ran it; the first one is over
    const closing = g.closeWriter();
    expect(inners).toHaveLength(2);
    expect(inners[0].stop).not.toHaveBeenCalled();
    expect(inners[1].stop).toHaveBeenCalledTimes(1);
    stops.forEach((r) => r());
    await closing;
    expect(real.run).toHaveBeenCalledTimes(2);
  });

  it('a caller that stopped its handle while held is not reattached', async () => {
    const { e, stops } = mk();
    const real = { run: e.run, attach: e.attach };
    const g = gateEngine(e as never, () => false);
    const h = eng(e).attach({ id: 'a1' });
    const closing = g.closeWriter();
    stops.forEach((r) => r());
    await closing;
    await h.stop();
    (real.attach as jest.Mock).mockClear();
    await g.attachHeld();
    expect(real.attach).not.toHaveBeenCalled();
  });

  it('run and attach during a quiesce get an idle or held proxy and start nothing', async () => {
    const { e } = mk();
    const real = { run: e.run, attach: e.attach };
    const g = gateEngine(e as never, () => false);
    const closing = g.closeWriter();
    expect(g.holding()).toBe(true);
    const r = eng(e).run({ id: 'r' });
    const a = eng(e).attach({ id: 'a' });
    await closing;
    expect(real.run).not.toHaveBeenCalled();
    expect(real.attach).not.toHaveBeenCalled();
    expect((r as never as { status: string }).status).toBe('paused');
    expect(a.status).toBe('paused');
    await g.attachHeld();
    expect(real.attach).toHaveBeenCalledTimes(1);
  });

  it('close twice then attachHeld attaches once', async () => {
    const { e, stops } = mk();
    const real = { run: e.run, attach: e.attach };
    const g = gateEngine(e as never, () => false);
    eng(e).attach({ id: 'a1' });
    const c1 = g.closeWriter();
    stops.forEach((r) => r());
    await c1;
    await g.closeWriter();
    (real.attach as jest.Mock).mockClear();
    await g.attachHeld();
    expect(real.attach).toHaveBeenCalledTimes(1);
  });

  it('a stop that throws does not stop the others from being held; closeWriter resolves', async () => {
    const log = jest.fn();
    const mkI = (fail: boolean) => ({
      status: 'running',
      stats: async () => ({ pending: 0 }),
      stop: jest.fn(async () => {
        if (fail) throw new Error('boom');
      }),
    });
    const e = idle({
      attach: jest
        .fn()
        .mockReturnValueOnce(mkI(false))
        .mockReturnValueOnce(mkI(true))
        .mockReturnValueOnce(mkI(false)),
    });
    const real = { run: e.run, attach: e.attach };
    const g = gateEngine(e as never, () => false, undefined as never, log);
    eng(e).attach({ id: 'a1' });
    eng(e).attach({ id: 'a2' });
    eng(e).attach({ id: 'a3' });
    await expect(g.closeWriter()).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith('warn', expect.stringContaining('boom'));
    (real.attach as jest.Mock).mockClear();
    await g.attachHeld();
    expect(real.attach).toHaveBeenCalledTimes(3);
  });
});

describe('write guard', () => {
  it('every write-tx path throws SyncReadOnly on a follower', () => {
    follower();
    const t = tx();
    const paths: (keyof typeof t)[] = (Object.keys(t) as (keyof typeof t)[]).filter((k) => k !== 'applyDelta' && k !== 'importSecrets');
    expect(paths.length).toBeGreaterThan(5);
    for (const p of paths) {
      expect(() => (t[p] as (...a: unknown[]) => unknown)({})).toThrow(SyncReadOnly);
    }
  });

  it('every write-tx path throws SyncReadOnly while joining', () => {
    joining();
    const t = tx();
    const paths: (keyof typeof t)[] = (Object.keys(t) as (keyof typeof t)[]).filter((k) => k !== 'applyDelta' && k !== 'importSecrets');
    for (const p of paths) {
      expect(() => (t[p] as (...a: unknown[]) => unknown)({})).toThrow(SyncReadOnly);
    }
  });

  it('applyDelta is not refused while joining', () => {
    joining();
    expect(() => tx().applyDelta(path.join(dir, 'missing'))).not.toThrow(SyncReadOnly);
  });

  it('importSecrets is not refused on a follower, and is not for anyone else', () => {
    follower();
    expect(tx().importSecrets([])).toEqual({ applied: 0 });
    db.prepare(`UPDATE sync_state SET role='normal'`).run();
    expect(() => tx().importSecrets([])).toThrow(/only a follower/);
  });

  it('applyDelta is not refused on a follower', () => {
    follower();
    expect(() => tx().applyDelta(path.join(dir, 'missing'))).not.toThrow(SyncReadOnly);
  });

  it('normal role behaves as today', () => {
    const r = tx().accountWrite({ op: 'create', source: 's', identifier: 'i' });
    expect(r).toBeTruthy();
  });

  it('role is read from the database and survives reopening', () => {
    expect(readRoleSync(db)).toBe('normal');
    follower();
    const file = db.name;
    db.close();
    db = new Database(file);
    expect(readRoleSync(db)).toBe('follower');
  });

  it('no statement outside write-tx and sync writes accounts or documents', () => {
    const root = path.resolve(__dirname, '..', '..', '..');
    const out = execFileSync(
      'grep',
      ['-rnE', '(UPDATE|INTO|DELETE FROM) +(documents|accounts)\\b', root, '--include=*.ts'],
      { encoding: 'utf8' },
    );
    const strays = out
      .split('\n')
      .filter(Boolean)
      .filter(
        (l) =>
          !/__tests__|core\/store\/(write-tx|schema)\.ts|core\/sync\//.test(l) &&
          !/^\S+:\d+:\s*(\/\/|\*)/.test(l),
      );
    expect(strays).toEqual([]);
  });
});

describe('side effects', () => {
  it('a follower finds no sender or calendar writer, whatever is registered', () => {
    const real = { get: (id: string) => ({ id }), ids: () => ['mail'] };
    expect(followerLookup(real, () => true).get('mail')).toBeUndefined();
    expect(followerLookup(real, () => true).ids()).toEqual(['mail']);
  });

  it('is read per call: the same lookup finds the sender once the device leads', () => {
    let ro = true;
    const real = { get: (id: string) => ({ id }), ids: () => ['mail'] };
    const l = followerLookup(real, () => ro);
    expect(l.get('mail')).toBeUndefined();
    ro = false;
    expect(l.get('mail')).toEqual({ id: 'mail' });
  });
});

describe('a device-owned sender (step 4)', () => {
  const SECRET = 'PLANTED-WA-KEYS';
  const sent: string[] = [];
  const real = {
    get: (id: string) =>
      id === 'whatsapp' || id === 'gmail'
        ? { send: async (i: { accountId: string }) => (sent.push(`${id}:${i.accountId}`), { externalMessageId: 'm' }) }
        : undefined,
    ids: () => ['whatsapp', 'gmail'],
  };
  const owner = (over: Record<string, unknown> = {}) => ({
    ownsAccount: (id: string) => id === 'mine',
    ownerOf: async (id: string) => (id === 'mine' || id === 'led' ? 'dev-me' : id === 'free' ? null : 'dev-other-1234'),
    deviceId: () => 'dev-me',
    deviceName: (d: string) => (d === 'dev-other-1234' ? 'Anna\'s MacBook' : d),
    ...over,
  });
  const send = (l: { get(id: string): unknown }, source: string, accountId: string) =>
    (l.get(source) as { send(i: unknown): Promise<unknown> } | undefined)?.send({ accountId, secret: SECRET });
  beforeEach(() => {
    sent.length = 0;
  });

  it('owner sends as a follower; the sender is found although the device is read-only', async () => {
    const l = followerLookup(real, () => true, owner());
    await expect(send(l, 'whatsapp', 'mine')).resolves.toEqual({ externalMessageId: 'm' });
    expect(sent).toEqual(['whatsapp:mine']);
  });

  it('the leader sends for an account it paired, or one with no owner yet', async () => {
    const l = followerLookup(real, () => false, owner());
    await send(l, 'whatsapp', 'led');
    await send(l, 'whatsapp', 'free');
    expect(sent).toEqual(['whatsapp:led', 'whatsapp:free']);
  });

  it('the master never sends for another device\'s whatsapp', async () => {
    const l = followerLookup(real, () => false, owner());
    await expect(send(l, 'whatsapp', 'theirs')).rejects.toThrow("Send from Anna's MacBook");
    expect(sent).toEqual([]);
  });

  it('send off the owner is refused with the device name, as a pre-delivery failure', async () => {
    const l = followerLookup(real, () => true, owner());
    await expect(send(l, 'whatsapp', 'theirs')).rejects.toThrow(/^not sent: Send from Anna's MacBook$/);
    expect(sent).toEqual([]);
  });

  it('a follower never sends for an account it merely holds a row of, even one with no owner', async () => {
    const l = followerLookup(real, () => true, owner());
    await expect(send(l, 'whatsapp', 'free')).rejects.toThrow('Send from');
    await expect(send(l, 'whatsapp', 'led')).rejects.toThrow('Send from');
    expect(sent).toEqual([]);
  });

  it('a row whose owner is gone runs nowhere: the refusal is all it gets', async () => {
    const l = followerLookup(real, () => false, owner({ ownerOf: async () => 'gone-device-0001' }));
    await expect(send(l, 'whatsapp', 'orphan')).rejects.toThrow('Send from gone-dev'.slice(0, 14));
    expect(sent).toEqual([]);
  });

  it('moveable accounts keep the role gate', async () => {
    expect(send(followerLookup(real, () => true, owner()), 'gmail', 'x')).toBeUndefined();
    await send(followerLookup(real, () => false, owner()), 'gmail', 'x');
    expect(sent).toEqual(['gmail:x']);
  });

  it('refusal text holds no credential', async () => {
    const l = followerLookup(real, () => true, owner());
    const err = await send(l, 'whatsapp', 'theirs')!.catch((e: Error) => e);
    expect(String((err as Error).message)).not.toContain(SECRET);
    expect(String((err as Error).stack)).not.toContain(SECRET);
  });

  it('whatsapp runs on its owner as a follower, and the master never starts another device\'s', () => {
    const run = jest.fn(() => ({ status: 'running' }));
    const e = { run, attach: jest.fn(), rerunDeferred: jest.fn() };
    gateEngine(e, () => true, { ownsAccount: (id) => id === 'mine', ownsSource: () => true });
    (e.run as unknown as (a: { id: string }) => unknown)({ id: 'mine' });
    (e.run as unknown as (a: { id: string }) => unknown)({ id: 'theirs' });
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe('gateEngine with device-owned accounts (step 3)', () => {
  const owned = {
    ownsAccount: (id: string) => id === 'mine',
    ownsSource: (s: string) => s === 'local-folder',
  };
  const callRun = (e: ReturnType<typeof idle>, id: string) =>
    (e.run as unknown as (a: { id: string }) => unknown)({ id });

  it('a follower runs an account it owns and refuses the others', () => {
    const e = idle();
    gateEngine(e as never, () => true, owned);
    expect((callRun(e, 'mine') as { inner: unknown }).inner).toBe('real');
    expect((callRun(e, 'theirs') as { status: string }).status).toBe('paused');
  });

  it('owner verbs pass for an owned account and throw SyncReadOnly for another', async () => {
    const e = idle();
    gateEngine(e as never, () => true, owned);
    const call = (name: string, ...a: unknown[]) =>
      (e as unknown as Record<string, (...x: unknown[]) => Promise<unknown>>)[name](...a);
    for (const verb of ['pause', 'resume', 'remove', 'updateConfig', 'setOption', 'applyScope'])
      await expect(call(verb, 'mine')).resolves.toBe('real');
    for (const verb of ['pause', 'resume', 'remove', 'updateConfig', 'setOption', 'applyScope'])
      await expect(call(verb, 'theirs')).rejects.toThrow(SyncReadOnly);
    // connect names a source, not an account.
    await expect(call('connect', { descriptor: { id: 'local-folder' } })).resolves.toBe('real');
    await expect(call('connect', { descriptor: { id: 'gmail' } })).rejects.toThrow(SyncReadOnly);
  });

  it('workers stay held on a follower, owned accounts or not', () => {
    const e = idle();
    const real = e.attach;
    gateEngine(e as never, () => true, owned);
    (e.attach as unknown as (w: unknown) => unknown)({});
    expect(real).not.toHaveBeenCalled();
  });
});
