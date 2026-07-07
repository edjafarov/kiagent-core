/**
 * Unit-level (no real transport): attachToolHandlers only touches
 * `mcp.server.setRequestHandler` + `mcp.server.getClientVersion`, so a
 * minimal stub capturing the two registered handlers is enough to drive
 * tools/list + tools/call directly.
 */
import type { McpActivityRecord, McpTool } from '@shared/contracts';

import { attachToolHandlers, createToolRegistry } from '../registry';

type ActivityRec = Omit<McpActivityRecord, 'transport'>;

function capture(clientName: string | null = 'claude-desktop') {
  const handlers: Array<(req: unknown) => Promise<unknown>> = [];
  const mcp = {
    server: {
      setRequestHandler: (
        _schema: unknown,
        fn: (req: unknown) => Promise<unknown>,
      ) => handlers.push(fn),
      getClientVersion: () =>
        clientName == null ? undefined : { name: clientName, version: '1.0' },
    },
  } as never;
  return { mcp, handlers }; // handlers[0] = tools/list, handlers[1] = tools/call
}
const logSink = { log: jest.fn() };

const okTool: McpTool = {
  name: 'search',
  description: '',
  inputSchema: {},
  call: async () => [{ title: 'Doc A' }],
};
const boomTool: McpTool = {
  name: 'boom',
  description: '',
  inputSchema: {},
  call: async () => {
    throw new Error('x');
  },
};

it('emits one enriched activity record per successful call', async () => {
  const registry = createToolRegistry([okTool]);
  const { mcp, handlers } = capture();
  const got: ActivityRec[] = [];
  attachToolHandlers(mcp, registry, logSink as never, (r) => got.push(r));
  await handlers[1]({ params: { name: 'search', arguments: { query: 'q' } } });
  expect(got).toHaveLength(1);
  const rec = got[0];
  expect(rec.ok).toBe(true);
  expect(rec.tool).toBe('search');
  expect(rec.client).toBe('claude-desktop');
  expect(rec.summary).toBe('search "q" → 1 hits');
  expect(rec.detail).toEqual(['Doc A']);
  expect(typeof rec.ms).toBe('number');
  expect('transport' in rec).toBe(false); // stamped by the caller, not here
});

it('emits ok:false with the error for throwing tools', async () => {
  const registry = createToolRegistry([boomTool]);
  const { mcp, handlers } = capture();
  const got: ActivityRec[] = [];
  attachToolHandlers(mcp, registry, logSink as never, (r) => got.push(r));
  await handlers[1]({ params: { name: 'boom', arguments: {} } });
  expect(got).toHaveLength(1);
  expect(got[0].ok).toBe(false);
  expect(got[0].error).toBe('x');
  expect(got[0].summary).toBe('boom failed');
});

it('emits ok:false for unknown tools', async () => {
  const registry = createToolRegistry([]);
  const { mcp, handlers } = capture();
  const got: ActivityRec[] = [];
  attachToolHandlers(mcp, registry, logSink as never, (r) => got.push(r));
  await handlers[1]({ params: { name: 'nope', arguments: {} } });
  expect(got).toHaveLength(1);
  expect(got[0].ok).toBe(false);
  expect(got[0].error).toBe('unknown tool');
});

it('client is null when the session has no clientInfo yet', async () => {
  const registry = createToolRegistry([okTool]);
  const { mcp, handlers } = capture(null);
  const got: ActivityRec[] = [];
  attachToolHandlers(mcp, registry, logSink as never, (r) => got.push(r));
  await handlers[1]({ params: { name: 'search', arguments: {} } });
  expect(got[0].client).toBeNull();
});

it('works without onActivity (callers may pass nothing)', async () => {
  const registry = createToolRegistry([okTool]);
  const { mcp, handlers } = capture();
  attachToolHandlers(mcp, registry, logSink as never);
  await expect(
    handlers[1]({ params: { name: 'search', arguments: {} } }),
  ).resolves.not.toThrow();
});

it('a throwing onActivity never breaks the call it records', async () => {
  const registry = createToolRegistry([okTool]);
  const { mcp, handlers } = capture();
  attachToolHandlers(mcp, registry, logSink as never, () => {
    throw new Error('sink exploded');
  });
  const res = (await handlers[1]({
    params: { name: 'search', arguments: {} },
  })) as { isError?: boolean };
  expect(res.isError).toBeUndefined();
});

it('still audits every call to the LogSink (the raw audit is unchanged)', async () => {
  logSink.log.mockClear();
  const registry = createToolRegistry([okTool]);
  const { mcp, handlers } = capture();
  attachToolHandlers(mcp, registry, logSink as never, () => {});
  await handlers[1]({ params: { name: 'search', arguments: {} } });
  expect(logSink.log).toHaveBeenCalledWith(
    'mcp.call',
    'info',
    'search',
    expect.objectContaining({ ok: true }),
  );
});
