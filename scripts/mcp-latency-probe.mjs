#!/usr/bin/env node
/**
 * External MCP latency probe (#146 spec §6). An MCP client, outside the app,
 * running a FIXED workload against the loopback server every `--interval` ms:
 *
 *   - 10 text searches (one fuzzy-only term, one account-restricted),
 *   - 2 recency / filter-only searches,
 *   - 1 digital_memory_info,
 *   - the 10 `get` ids (fixed per --ids file) issued CONCURRENTLY with `count`
 *     group_by label and from, which are STARTED FIRST so the gets overlap
 *     Query.countBy over the whole corpus,
 *   - 1 get_schema: static text, no database — its round trip is the proxy for
 *     main-process event-loop lag (converters, #147).
 *
 * Reports p50/p95 for search and get SEPARATELY. Usage:
 *   node scripts/mcp-latency-probe.mjs --url http://127.0.0.1:7421/mcp \
 *     --cycles 24 --interval 5000 --label during-sync --out during-sync.json \
 *     --diag /tmp/kia-read-diag.json --baseline idle.json --ids ids.json
 *   node scripts/mcp-latency-probe.mjs --url … --diag … --ids ids.json --validate-only
 * where --diag is the file the app writes with KIA_READ_DIAG_FILE=/tmp/kia-read-diag.json,
 * --baseline is the --out of an idle run and --ids is the workload file
 * `{ ids: [10 get ids], fuzzy: "<validated term>" }`. Order of use:
 *   1. new build:  --validate-only --diag … --ids ids.json   (validates + writes it)
 *   2. v0.104.0 baseline: --ids ids.json, NO --diag (that build has no
 *      diagnostics): it requires the file from step 1 and does not re-validate.
 *   3. new build measurement: --diag … --ids ids.json (re-validates the fuzzy
 *      term against the app's fuzzyRuns counter every run).
 * Last stdout line = JSON report. Exit 3 = the workload itself was invalid.
 *
 * Caveats: the fuzzy validation (`fuzzyRuns` increases across one search) can be
 * satisfied by a CONCURRENT fuzzy run from another client, so validate when no
 * other client is searching. The countBy check compares the diagnostics
 * snapshot taken at the start of measurement with a FRESH one taken after the
 * last cycle, and sums the cumulative `reads.totals` (not the windowed
 * `groups[].count`, which wraps) of `caller: 'mcp'` reader `countBy`.
 */
import fs from 'node:fs';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import {
  checkBaseline,
  checkSamples,
  collectIds,
  runGetsAndCounts,
  validateFuzzy,
  validateIds,
} from './mcp-latency-probe-workload.mjs';

function parseArgs(argv) {
  const o = {
    url: 'http://127.0.0.1:7421/mcp',
    cycles: 12,
    interval: 5000,
    terms: 'invoice,meeting,report,contract,payment,schedule,project,travel,"thank you"',
    fuzzy: 'rechnung',
    label: 'run',
    out: '',
    diag: '',
    baseline: '',
    ids: '',
    'validate-only': false,
  };
  // Options the caller actually passed (a saved validated workload wins over defaults, never over flags).
  const given = new Set();
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new Error(`unexpected argument ${a}`);
    const key = a.slice(2);
    if (!(key in o)) throw new Error(`unknown option ${a}`);
    given.add(key);
    if (typeof o[key] === 'boolean') {
      o[key] = true;
      continue;
    }
    i += 1;
    if (argv[i] === undefined) throw new Error(`${a} needs a value`);
    o[key] = typeof o[key] === 'number' ? Number(argv[i]) : argv[i];
  }
  return { ...o, given };
}

const percentile = (sorted, p) =>
  sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
const stat = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const r = (n) => Math.round(n * 10) / 10;
  return { n: s.length, p50: r(percentile(s, 0.5)), p95: r(percentile(s, 0.95)), max: r(s[s.length - 1] ?? 0) };
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const opts = parseArgs(process.argv.slice(2));
const samples = { search: [], get: [], count: [], info: [], loop: [] };

class InvalidWorkload extends Error {}
const invalid = (msg) => {
  throw new InvalidWorkload(msg);
};

const client = new Client({ name: 'kia-latency-probe', version: '1' });
await client.connect(new StreamableHTTPClientTransport(new URL(opts.url)));

async function call(name, args = {}) {
  const res = await client.callTool({ name, arguments: args });
  if (res.isError) throw new Error(`${name}: ${res.content?.[0]?.text}`);
  return JSON.parse(res.content[0].text);
}
/** A measured search that throws or returns a non-array is an invalid workload
 *  (exit 3), never a fast sample. */
async function searchChecked(args) {
  let r;
  try {
    r = await call('search', args);
  } catch (e) {
    invalid(`search ${JSON.stringify(args)} failed during measurement: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!Array.isArray(r)) invalid(`search ${JSON.stringify(args)} returned a non-array result during measurement`);
  return r;
}
async function timed(kind, fn) {
  const t0 = performance.now();
  const r = await fn();
  samples[kind].push(performance.now() - t0);
  return r;
}

/** The diagnostics snapshot written at or after `sinceMs` (the app stamps
 *  `snapshotAt` before it snapshots, every 5 s). */
async function readDiag(sinceMs, timeoutMs = 20_000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    try {
      const d = JSON.parse(fs.readFileSync(opts.diag, 'utf8'));
      if (d.snapshotAt >= sinceMs && typeof d.reads?.fuzzyRuns === 'number') return d;
    } catch {
      /* not written yet / mid-write: poll again */
    }
    if (Date.now() > end) {
      invalid(`${opts.diag} was not refreshed with reads.fuzzyRuns within ${timeoutMs} ms (KIA_READ_DIAG_FILE set on a build that has fuzzyRuns?)`);
    }
    await sleep(50);
  }
}
const readFuzzyRuns = async (sinceMs) => (await readDiag(sinceMs)).reads.fuzzyRuns;
/** Reader countBy executions attributed to the MCP caller. */
const mcpCountBy = (d) =>
  (d.reads?.totals ?? [])
    .filter((g) => g.method === 'countBy' && g.via === 'reader' && g.caller === 'mcp')
    .reduce((n, g) => n + g.total, 0);

async function main() {
  // ── Setup, BEFORE any measurement: the workload must be valid or the numbers
  // mean nothing (exit 3, never a quietly thinner run).
  const validateOnly = opts['validate-only'];
  if (validateOnly && !opts.diag) invalid('--validate-only needs --diag (the fuzzy proof is the app\'s fuzzyRuns counter)');
  if (validateOnly && !opts.ids) invalid('--validate-only needs --ids <file> to write the validated workload to');
  let saved = null;
  if (opts.ids && fs.existsSync(opts.ids)) saved = JSON.parse(fs.readFileSync(opts.ids, 'utf8'));
  if (!opts.diag) {
    // Baseline mode (v0.104.0 has no diagnostics): reuse a VALIDATED workload.
    if (!saved || !Array.isArray(saved.ids) || typeof saved.fuzzy !== 'string' || !saved.fuzzy) {
      invalid('without --diag the probe needs an --ids file produced by a validated run (--validate-only --diag …); none found or it has no validated fuzzy term');
    }
    opts.fuzzy = saved.fuzzy;
  } else if (saved && typeof saved.fuzzy === 'string' && saved.fuzzy && !opts.given.has('fuzzy')) {
    // New-build run after --validate-only: measure the SAME validated term as the baseline
    // (re-validated below); only an explicit --fuzzy replaces it.
    opts.fuzzy = saved.fuzzy;
  }
  // The 10 text queries: the configured terms, then the fuzzy-only term last.
  const queries = [...opts.terms.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 9), opts.fuzzy];
  while (queries.length < 10) queries.push(queries[queries.length - 1]);
  const accounts = (await call('digital_memory_info')).accounts ?? [];
  const restrictTo = accounts[0]?.source;

  let base = null;
  if (opts.baseline) {
    base = JSON.parse(fs.readFileSync(opts.baseline, 'utf8'));
    const bp = checkBaseline(base);
    if (bp.length > 0) invalid(bp.join('; '));
  }
  let ids = saved?.ids;
  if (!ids) {
    try {
      ids = await collectIds(call, queries);
    } catch (e) {
      invalid(e instanceof Error ? e.message : String(e));
    }
  }
  const idProblems = await validateIds(call, ids); // 10 distinct ids, each a real document
  if (idProblems.length > 0) invalid(idProblems.join('; '));
  if (opts.diag) {
    let fuzzyProblem;
    try {
      fuzzyProblem = await validateFuzzy(call, opts.fuzzy, readFuzzyRuns);
    } catch (e) {
      if (e instanceof InvalidWorkload) throw e;
      fuzzyProblem = `fuzzy search failed: ${e instanceof Error ? e.message : String(e)}`;
    }
    if (fuzzyProblem) invalid(fuzzyProblem);
    if (opts.ids) fs.writeFileSync(opts.ids, JSON.stringify({ ids, fuzzy: opts.fuzzy }, null, 2));
  }
  if (validateOnly) {
    process.stdout.write(`${JSON.stringify({ label: opts.label, validated: true, ids, fuzzy: opts.fuzzy })}\n`);
    return 0;
  }

  const startCountBy = opts.diag ? mcpCountBy(await readDiag(Date.now())) : 0;
  const badGets = [];
  for (let cycle = 0; cycle < opts.cycles; cycle += 1) {
    const started = performance.now();
    for (let i = 0; i < 10; i += 1) {
      const args = { query: queries[i], limit: 10 };
      if (i === 1 && restrictTo) args.source = restrictTo; // account-restricted
      await timed('search', () => searchChecked(args));
    }
    for (const extra of [{}, { query: 'has:attachment' }]) {
      await timed('search', () => searchChecked({ ...extra, limit: 10 })); // recency / filter-only
    }
    await timed('info', () => call('digital_memory_info'));
    badGets.push(...(await runGetsAndCounts({ call, timed, ids }))); // countBy first, gets overlap it
    await timed('loop', () => call('get_schema'));
    const rest = opts.interval - (performance.now() - started);
    if (cycle < opts.cycles - 1 && rest > 0) await sleep(rest);
  }
  const measuredUntil = Date.now();
  if (badGets.length > 0) {
    invalid(`${badGets.length} get call(s) returned no document (a failed get is not a sample): ${[...new Set(badGets)].join(', ')}`);
  }

  const report = {
    label: opts.label,
    at: new Date().toISOString(),
    cycles: opts.cycles,
    kinds: Object.fromEntries(Object.entries(samples).map(([k, v]) => [k, stat(v)])),
  };

  let exitCode = 0;
  const missing = checkSamples(report.kinds, opts.cycles);
  if (missing.length > 0) invalid(`missing samples: ${missing.join('; ')}`);
  if (opts.diag) {
    const diag = await readDiag(measuredUntil); // fresh: includes the last cycle
    const countBy = mcpCountBy(diag);
    const fb = diag.reads?.fallbacks ?? {};
    report.fallbacks = fb;
    report.readerCountBy = countBy;
    if (!(countBy > startCountBy)) {
      process.stderr.write(`WARN: readDiagnostics shows no new MCP countBy execution on the reader (${startCountBy} -> ${countBy})\n`);
      exitCode = 2;
    }
    if (Object.values(fb).some((n) => n > 0)) {
      process.stderr.write(`FAIL: reader fallbacks fired: ${JSON.stringify(fb)}\n`);
      exitCode = 1;
    }
  }
  if (base) {
    report.vsBaseline = {};
    for (const k of ['search', 'get']) {
      const ratio = report.kinds[k].p95 / base.kinds[k].p95;
      report.vsBaseline[k] = Math.round(ratio * 100) / 100;
      if (ratio > 2) {
        process.stderr.write(`FAIL: ${k} p95 ${report.kinds[k].p95} ms is ${ratio.toFixed(2)}x idle (${base.kinds[k].p95} ms)\n`);
        exitCode = 1;
      }
    }
  }
  for (const [k, v] of Object.entries(report.kinds)) {
    process.stderr.write(`${k.padEnd(7)} n=${String(v.n).padStart(4)}  p50=${v.p50} ms  p95=${v.p95} ms  max=${v.max} ms\n`);
  }
  if (opts.out) fs.writeFileSync(opts.out, JSON.stringify(report, null, 2));
  process.stdout.write(`${JSON.stringify(report)}\n`);
  return exitCode;
}

let code = 0;
try {
  code = await main();
} catch (e) {
  if (e instanceof InvalidWorkload) {
    process.stderr.write(`FAIL (invalid workload): ${e.message}\n`);
    code = 3;
  } else {
    process.stderr.write(`FAIL: ${e instanceof Error ? e.stack : String(e)}\n`);
    code = 1;
  }
} finally {
  await client.close().catch(() => {});
}
// Set the exit code and let the process end by itself: a hard process.exit()
// right after writing to a pipe truncates stdout/stderr on Windows.
process.exitCode = code;
