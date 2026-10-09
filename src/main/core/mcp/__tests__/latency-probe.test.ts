/**
 * @jest-environment node
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { openDb } from '../../../db/app-db';
import { startReadDiagnosticsDump } from '../../read-diagnostics';
import { createCorpusQuery } from '../../store/corpus-query';
import { openStore } from '../../store/store';
import { startMcp, type McpServerHandle } from '../server';
import { createTestSqlExecutor } from './helpers/sql-executor';

jest.setTimeout(120_000);

const run = promisify(execFile);
const PROBE = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  '..',
  'scripts',
  'mcp-latency-probe.mjs',
);

describe('scripts/mcp-latency-probe.mjs', () => {
  let dir: string;
  let handle: McpServerHandle;
  let stopDiag: () => void;
  let diag: string;
  /** Per-test knobs for what the diagnostics dump and the server report. */
  const scenario = {
    renderOnly: false,
    flatTotals: false,
    searchThrowsAfter: Infinity,
    searches: 0,
    fallbacks: {} as Record<string, number>,
    nullGetsAfter: Infinity,
    gets: 0,
  };
  let mcpCountBy = 0;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-probe-'));
    diag = path.join(dir, 'diag.json');
    const db = await openDb(path.join(dir, 'kiagent.db'));
    const store = openStore(db, {
      encrypt: (s: string) => Buffer.from(s, 'utf8'),
      decrypt: (b: Buffer) => b.toString('utf8'),
      detectLanguages: () => ['eng'],
    });
    const acc = await store.createAccount({
      source: 'gmail',
      identifier: 'me@example.com',
    });
    await store.commit({
      account: acc.id,
      cursor: 1,
      documents: Array.from({ length: 30 }, (_, i) => ({
        externalId: `m${i}`,
        type: 'email.message',
        title: `Invoice ${i}`,
        markdown: `the invoice and the meeting report ${i}`,
        metadata: { labels: ['INBOX'], from: `p${i % 3}@example.com` },
        createdAt: '2026-01-01T00:00:00Z',
      })),
    });
    // The server reads through a createCorpusQuery whose fuzzyRuns counter is
    // dumped like the app's KIA_READ_DIAG_FILE (same field names, 100 ms cadence).
    const corpus = createCorpusQuery(db, { languageCache: 'data-version' });
    stopDiag = startReadDiagnosticsDump(
      diag,
      async () => ({
        reads: {
          fuzzyRuns: corpus.fuzzyRuns(),
          // Windowed counts stay flat (a wrapped ring); the cumulative totals are what must rise.
          groups: [
            { caller: 'renderer', method: 'countBy', via: 'reader', count: 5 },
            { caller: 'mcp', method: 'countBy', via: 'reader', count: 18 },
          ],
          totals: scenario.renderOnly
            ? [
                {
                  caller: 'renderer',
                  method: 'countBy',
                  via: 'reader',
                  total: ++mcpCountBy,
                },
              ]
            : [
                {
                  caller: 'renderer',
                  method: 'countBy',
                  via: 'reader',
                  total: 99,
                },
                {
                  caller: 'mcp',
                  method: 'countBy',
                  via: 'reader',
                  total: scenario.flatTotals ? 7 : ++mcpCountBy,
                },
              ],
          fallbacks: scenario.fallbacks,
        },
      }),
      100,
    );
    handle = await startMcp({
      query: {
        ...corpus.query,
        search: async (...a: Parameters<typeof corpus.query.search>) => {
          scenario.searches += 1;
          if (scenario.searches > scenario.searchThrowsAfter)
            throw new Error('search boom');
          return corpus.query.search(...a);
        },
        document: async (id: Parameters<typeof corpus.query.document>[0]) => {
          scenario.gets += 1;
          return scenario.gets > scenario.nullGetsAfter
            ? null
            : corpus.query.document(id);
        },
      },
      logSink: { log: () => {} },
      dataDir: dir,
      portCandidates: [0],
      sqlExecutor: createTestSqlExecutor(path.join(dir, 'kiagent.db')),
    });
  });

  afterEach(() => {
    scenario.renderOnly = false;
    scenario.flatTotals = false;
    scenario.searchThrowsAfter = Infinity;
    scenario.searches = 0;
    scenario.fallbacks = {};
    scenario.nullGetsAfter = Infinity;
    scenario.gets = 0;
  });

  afterAll(async () => {
    stopDiag();
    await handle.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Common args; a real misspelling by default ("nvoic" occurs inside "Invoice"). */
  const probeArgs = (...extra: string[]) => [
    PROBE,
    '--url',
    `http://127.0.0.1:${handle.port}/mcp`,
    '--cycles',
    '1',
    '--interval',
    '0',
    '--diag',
    diag,
    '--fuzzy',
    'nvoic',
    ...extra,
  ];
  /** Baseline mode: NO --diag, no --fuzzy (the term comes from the validated file). */
  const baselineArgs = (...extra: string[]) => [
    PROBE,
    '--url',
    `http://127.0.0.1:${handle.port}/mcp`,
    '--cycles',
    '1',
    '--interval',
    '0',
    ...extra,
  ];
  const fail3 = (args: string[], stderr: RegExp) =>
    expect(run(process.execPath, args)).rejects.toMatchObject({
      code: 3,
      stderr: expect.stringMatching(stderr),
    });

  it('runs one cycle of the fixed workload and reports p50/p95 per kind (real misspelling: counter increases)', async () => {
    const ids = path.join(dir, 'ids.json');
    const { stdout } = await run(
      process.execPath,
      probeArgs('--label', 'test', '--ids', ids),
    );
    const report = JSON.parse(stdout.trim().split('\n').pop()!);
    expect(report.label).toBe('test');
    const saved = JSON.parse(fs.readFileSync(ids, 'utf8'));
    expect(saved.ids).toHaveLength(10);
    expect(saved.fuzzy).toBe('nvoic');
    expect(report.kinds.search.n).toBe(12); // 10 text searches + 2 recency/filter-only
    expect(report.kinds.get.n).toBe(10);
    expect(report.kinds.count.n).toBe(2); // group_by label + from
    expect(report.kinds.info.n).toBe(1);
    expect(report.kinds.loop.n).toBe(1);
    for (const k of ['search', 'get', 'count', 'info', 'loop']) {
      expect(report.kinds[k].p95).toBeGreaterThanOrEqual(report.kinds[k].p50);
    }
  });

  it('--validate-only validates, writes the workload file and exits 0 without measuring', async () => {
    const ids = path.join(dir, 'validated.json');
    const { stdout } = await run(
      process.execPath,
      probeArgs('--validate-only', '--ids', ids),
    );
    expect(JSON.parse(stdout.trim().split('\n').pop()!)).toMatchObject({
      validated: true,
      fuzzy: 'nvoic',
    });
    expect(JSON.parse(fs.readFileSync(ids, 'utf8'))).toMatchObject({
      fuzzy: 'nvoic',
    });
  });

  it('baseline mode (no --diag) reuses the validated file, takes its fuzzy term and does not re-validate', async () => {
    const ids = path.join(dir, 'validated.json'); // written by the previous test
    const { stdout } = await run(process.execPath, baselineArgs('--ids', ids));
    const report = JSON.parse(stdout.trim().split('\n').pop()!);
    expect(report.kinds.get.n).toBe(10);
    expect(report.kinds.search.n).toBe(12);
  });

  it('validate → baseline → new build without repeating --fuzzy measures the saved term, not the default', async () => {
    const ids = path.join(dir, 'chain.json');
    await run(process.execPath, probeArgs('--validate-only', '--ids', ids)); // saves fuzzy 'nvoic'
    await run(process.execPath, baselineArgs('--ids', ids));
    // New-build run: --diag but NO --fuzzy (the default would be 'rechnung').
    const noFuzzy = probeArgs('--ids', ids, '--label', 'after');
    const i = noFuzzy.indexOf('--fuzzy');
    noFuzzy.splice(i, 2);
    const { stdout } = await run(process.execPath, noFuzzy);
    expect(JSON.parse(stdout.trim().split('\n').pop()!).label).toBe('after');
    expect(JSON.parse(fs.readFileSync(ids, 'utf8')).fuzzy).toBe('nvoic'); // not overwritten by the default
  });

  it('baseline mode without a validated workload file exits 3', async () => {
    await fail3(baselineArgs(), /validated run/); // no --ids at all
    await fail3(
      baselineArgs('--ids', path.join(dir, 'does-not-exist.json')),
      /validated run/,
    );
    const noFuzzy = path.join(dir, 'no-fuzzy.json');
    fs.writeFileSync(
      noFuzzy,
      JSON.stringify({ ids: Array.from({ length: 10 }, (_, i) => `x${i}`) }),
    );
    await fail3(baselineArgs('--ids', noFuzzy), /validated run/);
  });

  it('exit 3 for a STEMMED term: the exact page is full, the fuzzy counter does not move', async () => {
    // 30 "invoice" documents fill the 10-hit page for "invoices": search returns hits,
    // but the trigram fallback never runs, so this term would skip the fuzzy workload.
    await fail3(probeArgs('--fuzzy', 'invoices'), /not fuzzy-only/);
  });

  it('exit 3 when the fuzzy term returns nothing', async () => {
    await fail3(
      probeArgs('--fuzzy', 'zzqxjk-no-such-substring'),
      /not fuzzy-only/,
    );
  });

  it('exit 3 when the ids file holds ids that are not documents (null gets) or are not distinct', async () => {
    const fake = path.join(dir, 'fake-ids.json');
    fs.writeFileSync(
      fake,
      JSON.stringify({
        ids: Array.from({ length: 10 }, (_, i) => `no-such-doc-${i}`),
        fuzzy: 'nvoic',
      }),
    );
    await fail3(probeArgs('--ids', fake), /invalid workload/);
    const dup = path.join(dir, 'dup-ids.json');
    fs.writeFileSync(
      dup,
      JSON.stringify({
        ids: Array.from({ length: 10 }, () => 'same'),
        fuzzy: 'nvoic',
      }),
    );
    await fail3(probeArgs('--ids', dup), /DISTINCT/);
  });

  it('exit 3 when the --baseline report has no get samples', async () => {
    const base = path.join(dir, 'bad-baseline.json');
    const k = (n: number, p95: number) => ({ n, p50: p95, p95, max: p95 });
    fs.writeFileSync(
      base,
      JSON.stringify({
        label: 'idle',
        cycles: 2,
        kinds: {
          search: k(24, 5),
          get: k(0, 0),
          count: k(4, 5),
          info: k(2, 1),
          loop: k(2, 1),
        },
      }),
    );
    await fail3(probeArgs('--baseline', base), /baseline get/);
  });

  const exits = (args: string[], code: number, stderr: RegExp) =>
    expect(run(process.execPath, args)).rejects.toMatchObject({
      code,
      stderr: expect.stringMatching(stderr),
    });

  it('exit 2 when only a renderer countBy ran on the reader (no MCP countBy)', async () => {
    scenario.renderOnly = true;
    await exits(probeArgs(), 2, /no new MCP countBy/);
  });

  it('exit 2 when MCP countBy totals are flat even though windowed counts exist', async () => {
    scenario.flatTotals = true;
    await exits(probeArgs(), 2, /no new MCP countBy/);
  });

  it('exit 3 when a search throws mid-measurement (after setup validated)', async () => {
    const ids = path.join(dir, 'search-throws.json');
    await run(process.execPath, probeArgs('--validate-only', '--ids', ids));
    // Setup issues a fixed number of query.search calls (the one fuzzy validation search);
    // learn it from a second validation run, then let only those through.
    scenario.searches = 0;
    await run(process.execPath, probeArgs('--validate-only', '--ids', ids));
    scenario.searchThrowsAfter = scenario.searches;
    scenario.searches = 0;
    await fail3(probeArgs('--ids', ids), /failed during measurement/);
  });

  it('exit 1 when a fallback is reported in the fresh end snapshot', async () => {
    scenario.fallbacks = { 'reader-error': 1 };
    await exits(probeArgs(), 1, /reader fallbacks fired/);
  });

  it('exit 1 when search/get p95 exceeds 2x the baseline', async () => {
    const base = path.join(dir, 'tight-baseline.json');
    const k = (n: number) => ({ n, p50: 0.001, p95: 0.001, max: 0.001 });
    fs.writeFileSync(
      base,
      JSON.stringify({
        label: 'idle',
        cycles: 1,
        kinds: {
          search: k(12),
          get: k(10),
          count: k(2),
          info: k(1),
          loop: k(1),
        },
      }),
    );
    await exits(probeArgs('--baseline', base), 1, /x idle/);
  });

  it('exit 3 when a get returns no document mid-measurement (after setup validated)', async () => {
    const ids = path.join(dir, 'midrun.json');
    await run(process.execPath, probeArgs('--validate-only', '--ids', ids));
    scenario.gets = 0;
    scenario.nullGetsAfter = 10; // the 10 validation gets pass, the measured ones return null
    await fail3(probeArgs('--ids', ids), /returned no document/);
  });
});
