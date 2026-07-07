/**
 * Three halves: (1) createActivityLog — the JSONL append/replay/tail/rotate/
 * reset lifecycle, including a two-writer-instances-one-file case that
 * simulates the main + stdio process pair; (2) summarizeCall — one case per
 * row of the spec's enrichment table; (3) the main.ts watcher-batch handler
 * (broadcast + ok-gated onboarding latch), mirrored here against the real
 * primitives.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  MCP_ACTIVITY_RECENT_MAX,
  type McpActivityRecord,
} from '@shared/contracts';

import { createPrefs, markOnboardingOnce } from '../../prefs';
import { createActivityLog, summarizeCall, ROTATE_BYTES } from '../activity';

function rec(over: Partial<McpActivityRecord> = {}): McpActivityRecord {
  return {
    ts: '2026-07-06T10:00:00.000Z',
    transport: 'stdio',
    client: 'claude-desktop',
    tool: 'search',
    ok: true,
    ms: 5,
    summary: 'search "x" → 1 hits',
    ...over,
  };
}

async function until(cond: () => boolean, ms = 4000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('until(): timed out');
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => {
      setTimeout(r, 25);
    });
  }
}

const sleep = (ms: number) =>
  new Promise((r) => {
    setTimeout(r, ms);
  });

describe('createActivityLog', () => {
  let dir: string;
  let stops: Array<() => void>;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-activity-'));
    stops = [];
  });
  afterEach(() => {
    for (const stop of stops) stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const file = () => path.join(dir, 'mcp-activity.jsonl');

  it('watch replays appended records as the first batch', async () => {
    const writer = createActivityLog(dir);
    writer.append(rec({ tool: 'a' }));
    writer.append(rec({ tool: 'b' }));
    await until(() => {
      try {
        return fs.readFileSync(file(), 'utf8').split('\n').length >= 3;
      } catch {
        return false;
      }
    });
    const reader = createActivityLog(dir);
    const got: McpActivityRecord[] = [];
    stops.push(reader.watch((rs) => got.push(...rs)));
    expect(got.map((r) => r.tool)).toEqual(['a', 'b']);
    expect(reader.recent().map((r) => r.tool)).toEqual(['a', 'b']);
  });

  it('a second writer instance reaches a live watcher (two-process shape)', async () => {
    const reader = createActivityLog(dir);
    const got: McpActivityRecord[] = [];
    stops.push(reader.watch((rs) => got.push(...rs)));
    const writerA = createActivityLog(dir);
    const writerB = createActivityLog(dir);
    writerA.append(rec({ tool: 'from-a' }));
    writerB.append(rec({ tool: 'from-b' }));
    await until(() => got.length === 2);
    expect(got.map((r) => r.tool).sort()).toEqual(['from-a', 'from-b']);
  });

  it('replay caps at MCP_ACTIVITY_RECENT_MAX, keeping the newest', async () => {
    const lines = [];
    for (let i = 0; i < MCP_ACTIVITY_RECENT_MAX + 50; i += 1) {
      lines.push(JSON.stringify(rec({ tool: `t${i}` })));
    }
    fs.writeFileSync(file(), `${lines.join('\n')}\n`);
    const reader = createActivityLog(dir);
    const got: McpActivityRecord[] = [];
    stops.push(reader.watch((rs) => got.push(...rs)));
    expect(got).toHaveLength(MCP_ACTIVITY_RECENT_MAX);
    expect(got[0].tool).toBe('t50');
    expect(got[got.length - 1].tool).toBe(`t${MCP_ACTIVITY_RECENT_MAX + 49}`);
  });

  it('buffers a partial line until its newline arrives', async () => {
    const reader = createActivityLog(dir);
    const got: McpActivityRecord[] = [];
    stops.push(reader.watch((rs) => got.push(...rs)));
    const line = JSON.stringify(rec({ tool: 'split' }));
    fs.appendFileSync(file(), line.slice(0, 10));
    await sleep(200);
    expect(got).toHaveLength(0);
    fs.appendFileSync(file(), `${line.slice(10)}\n`);
    await until(() => got.length === 1);
    expect(got[0].tool).toBe('split');
  });

  it('skips malformed lines without crashing', () => {
    fs.writeFileSync(
      file(),
      `not json at all\n${JSON.stringify(rec({ tool: 'good' }))}\n{"half":\n`,
    );
    const reader = createActivityLog(dir);
    const got: McpActivityRecord[] = [];
    stops.push(reader.watch((rs) => got.push(...rs)));
    expect(got.map((r) => r.tool)).toEqual(['good']);
  });

  it('rotates an oversized file at watch() setup, keeping the newest records', () => {
    const fat = rec({ summary: 'x'.repeat(600) });
    const lines = [];
    while (lines.length * 700 < ROTATE_BYTES + 200_000) {
      lines.push(JSON.stringify({ ...fat, tool: `t${lines.length}` }));
    }
    fs.writeFileSync(file(), `${lines.join('\n')}\n`);
    expect(fs.statSync(file()).size).toBeGreaterThan(ROTATE_BYTES);
    const reader = createActivityLog(dir);
    const got: McpActivityRecord[] = [];
    stops.push(reader.watch((rs) => got.push(...rs)));
    expect(fs.statSync(file()).size).toBeLessThan(ROTATE_BYTES);
    expect(got).toHaveLength(MCP_ACTIVITY_RECENT_MAX);
    expect(got[got.length - 1].tool).toBe(`t${lines.length - 1}`);
  });

  it('reset() truncates the file and clears recent()', async () => {
    const log = createActivityLog(dir);
    log.append(rec());
    await until(() => {
      try {
        return fs.statSync(file()).size > 0;
      } catch {
        return false;
      }
    });
    const got: McpActivityRecord[] = [];
    stops.push(log.watch((rs) => got.push(...rs)));
    expect(log.recent()).toHaveLength(1);
    log.reset();
    expect(log.recent()).toHaveLength(0);
    expect(fs.statSync(file()).size).toBe(0);
  });

  it('appends land even when the watcher starts before the file exists', async () => {
    const reader = createActivityLog(dir);
    const got: McpActivityRecord[] = [];
    stops.push(reader.watch((rs) => got.push(...rs)));
    createActivityLog(dir).append(rec({ tool: 'late' }));
    await until(() => got.length === 1);
    expect(got[0].tool).toBe('late');
  });
});

describe('main.ts watcher batch handler (broadcast + first-query latch)', () => {
  // Mirrors the closure main.ts passes to act.watch(...) exactly, with the
  // real markOnboardingOnce against a real prefs instance; `latch` wraps it
  // only so call counts are observable.
  let dir: string;
  let stops: Array<() => void>;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-activity-latch-'));
    stops = [];
  });
  afterEach(() => {
    for (const stop of stops) stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function setup() {
    const prefs = createPrefs(dir);
    const broadcast = jest.fn();
    const latch = jest.fn((key: 'firstQueryAt') =>
      markOnboardingOnce(prefs, key),
    );
    const handler = (recs: McpActivityRecord[]) => {
      broadcast('push:mcp-activity', recs);
      if (recs.some((r) => r.ok)) {
        latch('firstQueryAt').catch(() => {});
      }
    };
    return { prefs, broadcast, latch, handler };
  }

  it('a batch with at least one ok record latches firstQueryAt once', async () => {
    const { prefs, broadcast, latch, handler } = setup();
    // Pre-written file → watch() delivers the boot-replay batch synchronously
    // (the stdio-while-app-closed path that latches step 3).
    fs.writeFileSync(
      path.join(dir, 'mcp-activity.jsonl'),
      `${JSON.stringify(rec({ ok: false }))}\n${JSON.stringify(rec({ ok: true }))}\n`,
    );
    stops.push(createActivityLog(dir).watch(handler));
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledWith(
      'push:mcp-activity',
      expect.any(Array),
    );
    expect(latch).toHaveBeenCalledTimes(1);
    expect(latch).toHaveBeenCalledWith('firstQueryAt');
    await until(() => prefs.get().onboarding.firstQueryAt != null);
  });

  it('a batch of only failures broadcasts but does NOT latch', async () => {
    const { prefs, broadcast, latch, handler } = setup();
    fs.writeFileSync(
      path.join(dir, 'mcp-activity.jsonl'),
      `${JSON.stringify(rec({ ok: false }))}\n${JSON.stringify(rec({ ok: false, tool: 'get' }))}\n`,
    );
    stops.push(createActivityLog(dir).watch(handler));
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(latch).not.toHaveBeenCalled();
    await sleep(100);
    expect(latch).not.toHaveBeenCalled();
    expect(prefs.get().onboarding.firstQueryAt).toBeNull();
  });
});

describe('summarizeCall', () => {
  it('search with a query: quotes it, counts hits, details titles', () => {
    const out = summarizeCall('search', { query: 'invoices' }, [
      { title: 'Invoice March' },
      { title: '' },
    ]);
    expect(out.summary).toBe('search "invoices" → 2 hits');
    expect(out.detail).toEqual(['Invoice March', '(untitled)']);
  });

  it('search without query text shows the filters', () => {
    const out = summarizeCall(
      'search',
      { source: 'gmail', type: 'email.thread', from_date: 'x' },
      [],
    );
    expect(out.summary).toBe(
      'search (source=gmail, type=email.thread) → 0 hits',
    );
  });

  it('search with query AND filters shows both', () => {
    const out = summarizeCall('search', { query: 'q', source: 'gmail' }, []);
    expect(out.summary).toBe('search "q" (source=gmail) → 0 hits');
  });

  it('batch search sums hits across sub-results', () => {
    const out = summarizeCall(
      'search',
      { queries: [{ query: 'a' }, { query: 'b' }] },
      [[{ title: 'A' }], [{ title: 'B' }, { title: 'C' }]],
    );
    expect(out.summary).toBe('search ×2 queries → 3 hits');
    expect(out.detail).toEqual(['A', 'B', 'C']);
  });

  it('get single document', () => {
    const out = summarizeCall('get', { id: 'x' }, { title: 'Security alert' });
    expect(out.summary).toBe('fetched 1 document(s)');
    expect(out.detail).toEqual(['Security alert']);
  });

  it('get batch with misses reports not-found count', () => {
    const out = summarizeCall('get', { ids: ['a', 'b'] }, [
      { title: 'A' },
      null,
    ]);
    expect(out.summary).toBe('fetched 1 document(s), 1 not found');
    expect(out.detail).toEqual(['A']);
  });

  it('get single null is a miss', () => {
    const out = summarizeCall('get', { id: 'x' }, null);
    expect(out.summary).toBe('fetched 0 document(s), 1 not found');
    expect(out.detail).toBeUndefined();
  });

  it('get_related names the relation', () => {
    const out = summarizeCall(
      'get_related',
      { document_id: 'd', relation: 'attachments' },
      [{ title: 'invoice.pdf' }],
    );
    expect(out.summary).toBe('related "attachments" → 1 documents');
    expect(out.detail).toEqual(['invoice.pdf']);
  });

  it('count without grouping', () => {
    const out = summarizeCall('count', {}, [{ key: 'all', count: 1234 }]);
    expect(out.summary).toBe('counted: all=1234');
    expect(out.detail).toBeUndefined();
  });

  it('count grouped by source', () => {
    const out = summarizeCall('count', { group_by: 'source' }, [
      { key: 'gmail', count: 980 },
      { key: 'whatsapp', count: 254 },
    ]);
    expect(out.summary).toBe('counted by source: gmail=980, whatsapp=254');
  });

  it('digital_memory_info is a fixed line', () => {
    expect(summarizeCall('digital_memory_info', {}, {}).summary).toBe(
      'read corpus overview',
    );
  });

  it('unknown tools fall back to name + compact truncated args', () => {
    const out = summarizeCall('notion_query', { q: 'y'.repeat(300) }, {});
    expect(out.summary.startsWith('notion_query {"q":"yyy')).toBe(true);
    expect(out.summary.length).toBeLessThanOrEqual(
      'notion_query '.length + 121,
    );
    expect(out.detail).toBeUndefined();
  });

  it('caps detail at 20 titles with an overflow line', () => {
    const hits = Array.from({ length: 25 }, (_, i) => ({ title: `T${i}` }));
    const out = summarizeCall('search', { query: 'q' }, hits);
    expect(out.detail).toHaveLength(21);
    expect(out.detail![20]).toBe('…and 5 more');
  });
});
