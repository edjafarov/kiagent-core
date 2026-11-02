/** Plan Task 5: a follower reads and applies, and writes nothing else. */
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';

import { migrate } from '../../store/schema';
import { createWriteTx } from '../../store/write-tx';
import { applyFollowerGate, readRoleSync, SyncReadOnly } from '../role';

let dir: string;
let db: Database.Database;
const tx = () =>
  createWriteTx(db, { detectLanguages: () => ['eng'], now: () => 'n' });
const follower = () => db.prepare(`UPDATE sync_state SET role='follower'`).run();

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
  it('a follower runs no source pull and attaches no worker', async () => {
    const e = idle();
    applyFollowerGate(e as never);
    const pull = (e.run as unknown as (a: unknown) => { status: string; stats(): Promise<{ pending: number }> })({});
    expect(pull.status).toBe('paused');
    expect((await pull.stats()).pending).toBe(0);
    (e.attach as unknown as (w: unknown) => unknown)({});
    expect(await (e.rerunDeferred as unknown as (w: unknown) => Promise<unknown>)({})).toBeUndefined();
  });

  it.each(['connect', 'reconnect', 'applyScope', 'remove', 'pause', 'resume', 'updateConfig', 'setOption'])(
    '%s rejects on a follower',
    async (m) => {
      const real = idle();
      const spy = real[m as 'connect'];
      applyFollowerGate(real as never);
      await expect((real as never as Record<string, () => Promise<unknown>>)[m]()).rejects.toBeInstanceOf(SyncReadOnly);
      expect(spy).not.toHaveBeenCalled();
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
