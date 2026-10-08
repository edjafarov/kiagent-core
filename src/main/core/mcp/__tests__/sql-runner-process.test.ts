/**
 * @jest-environment node
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDb } from '../../../db/app-db';
import {
  createWorkerEnv,
  REPO_ROOT,
  WORKER_ENTRY,
} from '../../../db/__tests__/worker-test-env';
import { openReads } from '../../reads';
import { openStore } from '../../store/store';
import { createSqlRunner, type SqlRunner } from '../sql-runner';
import { forkRunnerChild } from '../sql-runner-spawn';

jest.setTimeout(120_000);

const ENTRY = path.join(__dirname, '..', 'sql-runner-entry.ts');
const SIGTERM_FIXTURE = path.join(
  __dirname,
  'fixtures',
  'sigterm-ignoring-runner.cjs',
);
// An aggregate over a recursive CTE yields no rows until it is done: only a
// process kill can stop it.
const HEAVY = `SELECT count(*) AS n FROM (WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < 2000000000) SELECT x FROM c)`;

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
};
const until = async (cond: () => boolean, ms = 15_000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 25));
  }
};

describe('SQL runner over real child processes', () => {
  const env = createWorkerEnv('sql-runner');
  let dir: string;
  let dbPath: string;
  let runner: SqlRunner | undefined;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-sqlrunner-'));
    dbPath = path.join(dir, 'kiagent.db');
    await (await openDb(dbPath)).close();
  });
  afterEach(async () => {
    await runner?.stop();
    runner = undefined;
  });
  afterAll(() => {
    env.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const real = (timeoutMs: number) =>
    createSqlRunner({
      spawn: () =>
        forkRunnerChild(ENTRY, {
          env: { KIA_SQL_RUNNER_DB: dbPath },
          execArgv: env.execArgv,
          cwd: REPO_ROOT,
        }),
      timeoutMs,
      idleMs: 60_000,
      startTimeoutMs: 90_000,
      termGraceMs: 1_000,
      killGraceMs: 5_000,
    });

  it('runs a statement, stops a runaway one for real, and recovers on a fresh child', async () => {
    runner = real(800);
    const first = await runner.exec('SELECT 1 AS one');
    expect(first.rows).toEqual([{ one: 1 }]);
    const pid1 = runner.diagnostics().pid!;
    expect(pid1).not.toBe(process.pid);

    // The main thread must stay responsive while the child burns CPU.
    let maxLag = 0;
    let last = Date.now();
    const tick = setInterval(() => {
      const n = Date.now();
      maxLag = Math.max(maxLag, n - last - 20);
      last = n;
    }, 20);
    await expect(runner.exec(HEAVY)).rejects.toThrow(/stopped after 0\.8 s/);
    expect(runner.diagnostics().state).toBe('stopping');
    await expect(runner.exec('SELECT 1')).rejects.toThrow(/still stopping/);
    await until(() => runner!.diagnostics().state === 'none');
    clearInterval(tick);
    expect(maxLag).toBeLessThan(300);
    expect(isAlive(pid1)).toBe(false); // the process EXITED, not just the call

    const again = await runner.exec('SELECT 2 AS two');
    expect(again.rows).toEqual([{ two: 2 }]);
    expect(runner.diagnostics().pid).not.toBe(pid1);
    expect(runner.diagnostics().timeouts).toBe(1);
  });

  it('real read worker keeps answering search + document while a runaway statement runs in the runner', async () => {
    const writerDb = await openDb(dbPath);
    const store = openStore(writerDb, {
      encrypt: (x: string) => Buffer.from(x, 'utf8'),
      decrypt: (b: Buffer) => b.toString('utf8'),
      detectLanguages: () => ['eng'],
    });
    const acct = (
      await store.createAccount({ source: 'test', identifier: 'me@x' })
    ).id;
    await store.commit({
      account: acct,
      cursor: 1,
      documents: [
        {
          externalId: 'live1',
          type: 'note',
          title: 'Live one',
          markdown: 'alpha runaway neighbour',
          metadata: {},
          createdAt: '2026-01-01T00:00:00Z',
        },
      ],
    });
    const plane = await openReads({
      dbPath,
      workerFile: WORKER_ENTRY,
      execArgv: env.execArgv,
      writer: store.read,
      weak: false,
      log: () => {},
    });
    try {
      const [seed] = await plane.reads.search({ text: 'alpha', limit: 1 });
      expect(seed).toBeDefined();
      runner = real(3_000);
      await runner.exec('SELECT 1'); // child ready before measuring
      let ok = 0;
      let stop = false;
      let maxLag = 0;
      let last = Date.now();
      const tick = setInterval(() => {
        const n = Date.now();
        maxLag = Math.max(maxLag, n - last - 20);
        last = n;
      }, 20);
      const reader = (async () => {
        while (!stop) {
          const hits = await plane.reads.search({ text: 'alpha', limit: 5 });
          const doc = await plane.reads.document(seed.id);
          if (hits.length > 0 && doc?.id === seed.id) ok += 1;
          await new Promise((r) => setTimeout(r, 50));
        }
      })();
      // While the runaway SQL burns CPU in the runner process, the read worker
      // keeps resolving successful search + document calls on the same DB file.
      await expect(runner.exec(HEAVY)).rejects.toThrow(/stopped after/);
      stop = true;
      await reader;
      clearInterval(tick);
      expect(ok).toBeGreaterThanOrEqual(5);
      expect(maxLag).toBeLessThan(300);
      await until(() => runner!.diagnostics().state === 'none');
    } finally {
      await plane.close();
      await store.close();
    }
  });

  it('bounds the result in bytes inside the child', async () => {
    runner = real(30_000);
    const r = await runner.exec(
      `WITH RECURSIVE c(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM c WHERE i < 600) SELECT i, hex(randomblob(100000)) AS big FROM c`,
    );
    expect(r.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(r.rows))).toBeLessThanOrEqual(
      1024 * 1024,
    );
  });

  it('escalates to SIGKILL when the child ignores SIGTERM', async () => {
    runner = createSqlRunner({
      spawn: () => forkRunnerChild(SIGTERM_FIXTURE),
      timeoutMs: 200,
      idleMs: 60_000,
      termGraceMs: 300,
      killGraceMs: 5_000,
    });
    const t0 = Date.now();
    await expect(runner.exec('SELECT 1')).rejects.toThrow(/stopped after/);
    const pid = runner.diagnostics().pid!;
    await until(() => runner!.diagnostics().state === 'none');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(200 + 300);
    expect(isAlive(pid)).toBe(false);
  });

  it('reports an unavailable runner when the entry cannot open the corpus', async () => {
    runner = createSqlRunner({
      spawn: () =>
        forkRunnerChild(ENTRY, {
          env: { KIA_SQL_RUNNER_DB: path.join(dir, 'missing.db') },
          execArgv: env.execArgv,
          cwd: REPO_ROOT,
        }),
      timeoutMs: 5_000,
      idleMs: 60_000,
      startTimeoutMs: 90_000,
    });
    await expect(runner.exec('SELECT 1')).rejects.toThrow(/unavailable/);
  });
});
