/**
 * Unit-level (no real transport): attachToolHandlers only touches
 * `mcp.server.setRequestHandler` + `mcp.server.getClientVersion`, so a
 * minimal stub capturing the two registered handlers is enough to drive
 * tools/list + tools/call directly.
 */
import type { McpActivityRecord, McpTool } from '@shared/contracts';

import {
  attachToolHandlers,
  createToolRegistry,
  redactArgsForLog,
} from '../registry';

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

it('still audits every call to the LogSink when an activity callback is attached', async () => {
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

describe('audit log redaction', () => {
  it('redacts body and recipient counts for a draft_message-shaped call', async () => {
    logSink.log.mockClear();
    const draftTool: McpTool = {
      name: 'draft_message',
      description: '',
      inputSchema: {},
      call: async () => ({ draftId: 'd1' }),
    };
    const registry = createToolRegistry([draftTool]);
    const { mcp, handlers } = capture();
    attachToolHandlers(mcp, registry, logSink as never);
    const body = 'x'.repeat(500);
    await handlers[1]({
      params: {
        name: 'draft_message',
        arguments: {
          account_id: 'acct-1',
          to: ['a@x', 'b@x'],
          subject: 'hello',
          body,
        },
      },
    });
    const [, , , fields] = logSink.log.mock.calls[0] as [
      string,
      string,
      string,
      { args: Record<string, unknown> },
    ];
    expect(fields.args.body).toBe(`[redacted: ${body.length} chars]`);
    expect(fields.args.to).toBe('[2 recipients]');
    expect(fields.args.subject).toBe('hello');
    expect(fields.args.account_id).toBe('acct-1');
  });

  it('truncates a long sql/query string with a suffix', async () => {
    logSink.log.mockClear();
    const sqlTool: McpTool = {
      name: 'query_sql',
      description: '',
      inputSchema: {},
      call: async () => ({ rows: [] }),
    };
    const registry = createToolRegistry([sqlTool]);
    const { mcp, handlers } = capture();
    attachToolHandlers(mcp, registry, logSink as never);
    const sql = 'a'.repeat(1000);
    await handlers[1]({
      params: { name: 'query_sql', arguments: { sql } },
    });
    const [, , , fields] = logSink.log.mock.calls[0] as [
      string,
      string,
      string,
      { args: Record<string, unknown> },
    ];
    expect(fields.args.sql).toBe(`${'a'.repeat(200)}…(+800 chars)`);
  });

  it('redacts args on the unknown-tool path', async () => {
    logSink.log.mockClear();
    const registry = createToolRegistry([]);
    const { mcp, handlers } = capture();
    attachToolHandlers(mcp, registry, logSink as never);
    const body = 'y'.repeat(500);
    await handlers[1]({
      params: { name: 'nope', arguments: { body, to: ['a@x'] } },
    });
    const [, , , fields] = logSink.log.mock.calls[0] as [
      string,
      string,
      string,
      { args: Record<string, unknown> },
    ];
    expect(fields.args.body).toBe(`[redacted: ${body.length} chars]`);
    expect(fields.args.to).toBe('[1 recipients]');
  });

  it('redacts args on the throwing-tool path', async () => {
    logSink.log.mockClear();
    const registry = createToolRegistry([boomTool]);
    const { mcp, handlers } = capture();
    attachToolHandlers(mcp, registry, logSink as never);
    const body = 'z'.repeat(500);
    await handlers[1]({
      params: { name: 'boom', arguments: { body } },
    });
    const [, , , fields] = logSink.log.mock.calls[0] as [
      string,
      string,
      string,
      { args: Record<string, unknown> },
    ];
    expect(fields.args.body).toBe(`[redacted: ${body.length} chars]`);
  });

  it('the tool itself still receives the raw args (redaction is a log-only copy)', async () => {
    const draftTool: McpTool = {
      name: 'draft_message',
      description: '',
      inputSchema: {},
      call: async (args) => ({ echoedBody: args.body }),
    };
    const registry = createToolRegistry([draftTool]);
    const { mcp, handlers } = capture();
    attachToolHandlers(mcp, registry, logSink as never);
    const body = 'w'.repeat(500);
    const res = (await handlers[1]({
      params: { name: 'draft_message', arguments: { body } },
    })) as { content: Array<{ text: string }> };
    const parsed = JSON.parse(res.content[0].text) as { echoedBody: string };
    expect(parsed.echoedBody).toBe(body);
  });
});

describe('redactArgsForLog', () => {
  it('redacts known body-like keys holding strings', () => {
    const out = redactArgsForLog({
      body: 'hello world',
      body_markdown: '# hi',
      markdown: 'md',
      text: 'plain',
      content: 'stuff',
    });
    expect(out).toEqual({
      body: '[redacted: 11 chars]',
      body_markdown: '[redacted: 4 chars]',
      markdown: '[redacted: 2 chars]',
      text: '[redacted: 5 chars]',
      content: '[redacted: 5 chars]',
    });
  });

  it('counts recipients for to/cc/bcc, array or single string', () => {
    const out = redactArgsForLog({
      to: ['a@x', 'b@x', 'c@x'],
      cc: 'single@x',
      bcc: [],
    });
    expect(out).toEqual({
      to: '[3 recipients]',
      cc: '[1 recipients]',
      bcc: '[0 recipients]',
    });
  });

  it('caps any other long string at 200 chars with a suffix', () => {
    const long = 'q'.repeat(250);
    const out = redactArgsForLog({ note: long });
    expect(out.note).toBe(`${'q'.repeat(200)}…(+50 chars)`);
  });

  it('passes through short strings unchanged', () => {
    const out = redactArgsForLog({ subject: 'short' });
    expect(out.subject).toBe('short');
  });

  it('caps large arrays and objects by JSON size, passes small ones through', () => {
    const bigArray = Array.from({ length: 100 }, (_, i) => i);
    const smallArray = [1, 2, 3];
    const bigObject = { a: 'x'.repeat(250) };
    const smallObject = { a: 1 };
    const out = redactArgsForLog({
      bigArray,
      smallArray,
      bigObject,
      smallObject,
    });
    expect(out.bigArray).toBe(
      `[array: ${JSON.stringify(bigArray).length} chars]`,
    );
    expect(out.smallArray).toEqual(smallArray);
    expect(out.bigObject).toBe(
      `[object: ${JSON.stringify(bigObject).length} chars]`,
    );
    expect(out.smallObject).toEqual(smallObject);
  });

  it('passes through numbers, booleans, and null unchanged', () => {
    const out = redactArgsForLog({ n: 42, b: true, nil: null });
    expect(out).toEqual({ n: 42, b: true, nil: null });
  });
});
