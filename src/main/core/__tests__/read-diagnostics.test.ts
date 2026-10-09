/** @jest-environment node */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildReadDiagnostics,
  startReadDiagnosticsDump,
} from '../read-diagnostics';
import { createReadStats } from '../store/read-proxy';

describe('buildReadDiagnostics', () => {
  const stats = () => {
    const s = createReadStats();
    s.record({
      caller: 'mcp',
      method: 'countBy',
      via: 'reader',
      execMs: 40,
      totalMs: 45,
      at: 1_000,
      fuzzyRuns: 7,
    });
    return s;
  };

  it('combines read stats, the SQL runner state and the -wal size', async () => {
    const d = await buildReadDiagnostics({
      stats: stats(),
      walPath: '/x/kiagent.db-wal',
      statFile: async () => ({ size: 4096 }),
      sql: { state: 'ready', pid: 77, timeouts: 2, recent: [] },
      now: 2_000,
    });
    expect(d.walBytes).toBe(4096);
    expect(d.reads.fuzzyRuns).toBe(7);
    expect(d.reads.totals).toEqual([
      { caller: 'mcp', method: 'countBy', via: 'reader', total: 1 },
    ]);
    expect(d.sql).toEqual({ state: 'ready', pid: 77, timeouts: 2, recent: [] });
    expect(d.reads.groups[0]).toMatchObject({
      caller: 'mcp',
      method: 'countBy',
      via: 'reader',
      count: 1,
      newestAgeMs: 1_000,
    });
  });

  it('reports null for a missing -wal and for an app without a runner', async () => {
    const d = await buildReadDiagnostics({
      stats: stats(),
      walPath: '/nope',
      statFile: async () => {
        throw new Error('ENOENT');
      },
    });
    expect(d.walBytes).toBeNull();
    expect(d.sql).toBeNull();
  });
});

describe('startReadDiagnosticsDump', () => {
  it('writes the snapshot immediately and again every interval until stopped', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-diag-'));
    const file = path.join(dir, 'diag.json');
    let n = 0;
    const stop = startReadDiagnosticsDump(
      file,
      async () => {
        n += 1;
        return { n };
      },
      20,
    );
    const waitFor = async (cond: () => boolean) => {
      const end = Date.now() + 3_000;
      while (!cond()) {
        if (Date.now() > end) throw new Error('timeout');
        await new Promise((r) => setTimeout(r, 10));
      }
    };
    await waitFor(
      () =>
        fs.existsSync(file) && JSON.parse(fs.readFileSync(file, 'utf8')).n >= 2,
    );
    expect(typeof JSON.parse(fs.readFileSync(file, 'utf8')).snapshotAt).toBe(
      'number',
    );
    stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
