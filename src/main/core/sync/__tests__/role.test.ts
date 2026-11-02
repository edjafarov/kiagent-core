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
    gateEngine(e as never, () => ro);
    expect(pull(e).status).toBe('paused');
    ro = false;
    expect(pull(e)).toBe('real');
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

describe('write guard', () => {
  it('every write-tx path throws SyncReadOnly on a follower', () => {
    follower();
    const t = tx();
    const paths: (keyof typeof t)[] = (Object.keys(t) as (keyof typeof t)[]).filter((k) => k !== 'applyDelta');
    expect(paths.length).toBeGreaterThan(5);
    for (const p of paths) {
      expect(() => (t[p] as (...a: unknown[]) => unknown)({})).toThrow(SyncReadOnly);
    }
  });

  it('every write-tx path throws SyncReadOnly while joining', () => {
    joining();
    const t = tx();
    const paths: (keyof typeof t)[] = (Object.keys(t) as (keyof typeof t)[]).filter((k) => k !== 'applyDelta');
    for (const p of paths) {
      expect(() => (t[p] as (...a: unknown[]) => unknown)({})).toThrow(SyncReadOnly);
    }
  });

  it('applyDelta is not refused while joining', () => {
    joining();
    expect(() => tx().applyDelta(path.join(dir, 'missing'))).not.toThrow(SyncReadOnly);
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
