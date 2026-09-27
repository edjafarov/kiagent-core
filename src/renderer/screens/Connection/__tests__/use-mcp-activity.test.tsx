import { act, renderHook } from '@testing-library/react';
import type { McpActivityRecord } from '@shared/contracts';
import { MCP_ACTIVITY_RECENT_MAX } from '@shared/contracts';
import { useMcpActivity } from '../use-mcp-activity';

const rec = (summary: string): McpActivityRecord => ({
  ts: '2026-09-24T11:00:00.000Z',
  transport: 'http',
  client: 'claude-code',
  tool: 'search',
  ok: true,
  ms: 3,
  summary,
});
const sums = (r: McpActivityRecord[]) => r.map((x) => x.summary);

let push: ((batch: McpActivityRecord[]) => void) | null;
function bridge(seed: Promise<McpActivityRecord[]>) {
  push = null;
  (window as any).kiagent = {
    invoke: jest.fn(() => seed),
    on: jest.fn((_c: string, cb: (b: McpActivityRecord[]) => void) => {
      push = cb;
      return () => {};
    }),
  };
}
afterEach(() => {
  delete (window as any).kiagent;
});

test('paints the cached trail first, then writes the seed and pushes back', async () => {
  let resolve!: (v: McpActivityRecord[]) => void;
  bridge(
    new Promise((r) => {
      resolve = r;
    }),
  );
  const write = jest.fn();
  const { result } = renderHook(() =>
    useMcpActivity({ read: () => [rec('cached')], write }),
  );
  expect(sums(result.current)).toEqual(['cached']);
  await act(async () => resolve([rec('seed')]));
  expect(sums(result.current)).toEqual(['seed']);
  act(() => push!([rec('live')]));
  expect(sums(result.current)).toEqual(['seed', 'live']);
  expect(sums(write.mock.calls.at(-1)[0])).toEqual(['seed', 'live']);
});

test('keeps the cap and survives a failed seed without a cache', async () => {
  bridge(Promise.reject(new Error('down')));
  const { result } = renderHook(() => useMcpActivity());
  await act(async () => {});
  expect(result.current).toEqual([]);
  const many = Array.from({ length: MCP_ACTIVITY_RECENT_MAX + 5 }, (_, i) =>
    rec(`r${i}`),
  );
  act(() => push!(many));
  expect(result.current).toHaveLength(MCP_ACTIVITY_RECENT_MAX);
  expect(result.current.at(-1)!.summary).toBe(
    `r${MCP_ACTIVITY_RECENT_MAX + 4}`,
  );
});
