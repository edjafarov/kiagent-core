/** @jest-environment node */
import { execFile } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const WORKLOAD = pathToFileURL(
  path.resolve(
    __dirname,
    '..',
    '..',
    '..',
    '..',
    '..',
    'scripts',
    'mcp-latency-probe-workload.mjs',
  ),
).href;

const node = async (body: string) => {
  const { stdout } = await run(process.execPath, [
    '--input-type=module',
    '-e',
    `import * as w from ${JSON.stringify(WORKLOAD)};\n${body}`,
  ]);
  return JSON.parse(stdout.trim().split('\n').pop()!);
};

describe('probe workload', () => {
  it('starts BOTH countBy calls before issuing the gets, so the gets overlap the aggregate', async () => {
    const events: string[] = await node(`
      const events = [];
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const call = async (name, args) => {
        const tag = name + ':' + (args.group_by ?? args.id);
        events.push('start:' + tag);
        if (name === 'count') await sleep(300); // a slow countBy
        events.push('end:' + tag);
        return {};
      };
      const timed = async (kind, fn) => fn();
      await w.runGetsAndCounts({ call, timed, ids: ['a', 'b', 'c'] });
      console.log(JSON.stringify(events));
    `);
    const at = (e: string) => events.indexOf(e);
    // both aggregates started first...
    expect(at('start:count:label')).toBeLessThan(at('start:get:a'));
    expect(at('start:count:from')).toBeLessThan(at('start:get:a'));
    // ...and every get was issued AND finished while they were still in flight
    for (const id of ['a', 'b', 'c']) {
      expect(at(`start:get:${id}`)).toBeLessThan(at('end:count:label'));
      expect(at(`end:get:${id}`)).toBeLessThan(at('end:count:label'));
      expect(at(`end:get:${id}`)).toBeLessThan(at('end:count:from'));
    }
  });

  it('a get that returns null / {} is reported as bad, not as a success', async () => {
    const bad: string[] = await node(`
      const call = async (name, args) => (name === 'get' ? (args.id === 'a' ? null : args.id === 'b' ? {} : { id: args.id, title: 't' }) : {});
      const timed = async (kind, fn) => fn();
      console.log(JSON.stringify(await w.runGetsAndCounts({ call, timed, ids: ['a', 'b', 'c'] })));
    `);
    expect(bad).toEqual(['a', 'b']);
  });

  it('validateIds rejects duplicate ids and ids that are not documents', async () => {
    const out = await node(`
      const ids = Array.from({ length: 10 }, (_, i) => 'd' + i);
      const call = async (name, args) => (args.id === 'd3' ? null : { id: args.id, title: 't' });
      console.log(JSON.stringify({
        ok: await w.validateIds(async (n, a) => ({ id: a.id, title: 't' }), ids),
        dup: await w.validateIds(call, Array(10).fill('d1')),
        missing: await w.validateIds(call, ids),
      }));
    `);
    expect(out.ok).toEqual([]);
    expect(out.dup.join(' ')).toMatch(/DISTINCT/);
    expect(out.missing.join(' ')).toMatch(/d3/);
  });

  it('validateFuzzy needs the app fuzzyRuns counter to move AND at least one search hit', async () => {
    const out = await node(`
      // readRuns returns the counter; the search itself bumps it by \`bump\`.
      const mk = (bump, hits) => {
        let runs = 4;
        return {
          call: async () => { runs += bump; return hits; },
          readRuns: async () => runs,
        };
      };
      const run = async (bump, hits, term) => {
        const m = mk(bump, hits);
        return w.validateFuzzy(m.call, term, m.readRuns);
      };
      console.log(JSON.stringify({
        misspelling: await run(1, [{ id: 'x' }], 'nvoic'),
        stemmed: await run(0, [{ id: 'x' }], 'invoices'),
        nothing: await run(1, [], 'zzz'),
      }));
    `);
    expect(out.misspelling).toBeNull();
    expect(out.stemmed).toMatch(/not fuzzy-only/);
    expect(out.nothing).toMatch(/not fuzzy-only/);
  });

  it('checkBaseline rejects a baseline without get samples or with p95 0', async () => {
    const out = await node(`
      const k = (n, p95) => ({ n, p50: p95, p95, max: p95 });
      const good = { cycles: 2, kinds: { search: k(24, 5), get: k(20, 4), count: k(4, 5), info: k(2, 1), loop: k(2, 1) } };
      const noGet = { cycles: 2, kinds: { ...good.kinds, get: k(0, 0) } };
      console.log(JSON.stringify({ good: w.checkBaseline(good), noGet: w.checkBaseline(noGet) }));
    `);
    expect(out.good).toEqual([]);
    expect(out.noGet.join(' ')).toMatch(/baseline get/);
  });

  it('checkSamples flags missing samples and passes a complete report', async () => {
    const out = await node(`
      const full = { search: { n: 24 }, get: { n: 20 }, count: { n: 4 }, info: { n: 2 }, loop: { n: 2 } };
      const short = { ...full, get: { n: 19 }, search: { n: 0 } };
      console.log(JSON.stringify({ ok: w.checkSamples(full, 2), bad: w.checkSamples(short, 2) }));
    `);
    expect(out.ok).toEqual([]);
    expect(out.bad).toHaveLength(2);
    expect(out.bad.join(' ')).toMatch(/get/);
    expect(out.bad.join(' ')).toMatch(/search/);
  });
});
