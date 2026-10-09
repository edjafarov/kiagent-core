/** @jest-environment node */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { McpTool, Query } from '@shared/contracts';

import { openDb } from '../../../db/app-db';
import { createAdmission } from '../../admission';
import { attachToolHandlers, createToolRegistry } from '../registry';
import { attachResourceHandlers } from '../resources';
import { startMcp } from '../server';
import { createTestSqlExecutor } from './helpers/sql-executor';

const idleLane = {
  processing: () => ({ enabled: true, window: 'always' as const }),
  env: () => ({ onBattery: false, userActive: false }),
  weak: () => false,
  syncing: () => false,
};
const admission = () =>
  createAdmission({ slots: 1, userActive: () => false, enrichment: idleLane });

function capture() {
  const handlers: Array<(req: unknown) => Promise<unknown>> = [];
  const mcp = {
    server: {
      setRequestHandler: (
        _s: unknown,
        fn: (req: unknown) => Promise<unknown>,
      ) => handlers.push(fn),
      getClientVersion: () => ({ name: 'test', version: '1' }),
    },
  } as never;
  return { mcp, handlers };
}

function fakeQuery(over: Partial<Query> = {}): Query {
  return {
    async document() {
      return null;
    },
    async children() {
      return [];
    },
    async byExternalId() {
      return null;
    },
    async search() {
      return [];
    },
    async count() {
      return 0;
    },
    async countBy() {
      return [];
    },
    async accounts() {
      return [];
    },
    ...over,
  };
}

const probeTool = (
  a: ReturnType<typeof admission>,
  seen: number[],
  fail = false,
): McpTool => ({
  name: 'probe',
  description: '',
  inputSchema: {},
  call: async () => {
    seen.push(a.snapshot().foregroundInFlight);
    if (fail) throw new Error('boom');
    return 'ok';
  },
});

describe('foreground entry/exit (#147 §2)', () => {
  it.each([false, true])(
    'tools/call is foreground for its whole run (throws: %p)',
    async (fail) => {
      const a = admission();
      const seen: number[] = [];
      const { mcp, handlers } = capture();
      attachToolHandlers(
        mcp,
        createToolRegistry([probeTool(a, seen, fail)]),
        { log: () => {} } as never,
        undefined,
        undefined,
        (fn) =>
          (async () => {
            const leave = a.foreground();
            try {
              return await fn();
            } finally {
              leave();
            }
          })(),
      );
      await handlers[1]({ params: { name: 'probe', arguments: {} } });
      expect(seen).toEqual([1]);
      expect(a.snapshot().foregroundInFlight).toBe(0);
    },
  );

  it.each([false, true])(
    'resources/read is foreground (throws: %p)',
    async (fail) => {
      const a = admission();
      const seen: number[] = [];
      const { mcp, handlers } = capture();
      attachResourceHandlers(
        mcp,
        fakeQuery({
          document: async () => {
            seen.push(a.snapshot().foregroundInFlight);
            if (fail) throw new Error('boom');
            return null;
          },
        }),
        (fn) =>
          (async () => {
            const leave = a.foreground();
            try {
              return await fn();
            } finally {
              leave();
            }
          })(),
      );
      await handlers[2]({ params: { uri: 'doc://x' } }).catch(() => {});
      expect(seen).toEqual([1]);
      expect(a.snapshot().foregroundInFlight).toBe(0);
    },
  );

  it('startMcp wires admission: callTool runs in foreground and leaves on throw', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-fg-'));
    const seed = await openDb(path.join(dir, 'kiagent.db'));
    await seed.close();
    const a = admission();
    const handle = await startMcp({
      query: fakeQuery(),
      sqlExecutor: createTestSqlExecutor(path.join(dir, 'kiagent.db')),
      logSink: { log: () => {} },
      dataDir: dir,
      portCandidates: [0],
      admission: a,
    });
    try {
      const seen: number[] = [];
      handle.registerTool(probeTool(a, seen, true));
      const out = await handle.callTool(
        'probe',
        {},
        { transport: 'agent', allowTools: ['probe'], client: 't' },
      );
      expect(out.ok).toBe(false);
      expect(seen[0]).toBeGreaterThanOrEqual(1);
      expect(a.snapshot().foregroundInFlight).toBe(0);
    } finally {
      await handle.stop();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
