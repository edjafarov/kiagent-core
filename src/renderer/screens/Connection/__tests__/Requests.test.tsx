import React from 'react';
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import type { McpActivityRecord } from '@shared/contracts';
import { MCP_ACTIVITY_RECENT_MAX } from '@shared/contracts';
import { Requests } from '../Requests';

const rec = (
  summary: string,
  over: Partial<McpActivityRecord> = {},
): McpActivityRecord => ({
  ts: new Date().toISOString(),
  transport: 'http',
  client: 'claude-code',
  tool: 'search',
  ok: true,
  ms: 3,
  summary,
  ...over,
});

let push: ((batch: McpActivityRecord[]) => void) | null;
function mount(seed: Promise<McpActivityRecord[]>) {
  push = null;
  (window as any).kiagent = {
    invoke: jest.fn(() => seed),
    on: jest.fn((_c: string, cb: (b: McpActivityRecord[]) => void) => {
      push = cb;
      return () => {};
    }),
  };
  render(<Requests />);
}
afterEach(() => {
  delete (window as any).kiagent;
});

const summaries = () =>
  screen
    .getAllByRole('listitem')
    .map((li) => li.querySelector('.conn-req-sum')?.textContent);

test('seeds newest first and names the app from the brand table', async () => {
  mount(
    Promise.resolve([
      rec('read schema'),
      rec('search "Q3 invoice" → 5 hits', {
        client: 'openai-mcp',
        transport: 'remote',
      }),
    ]),
  );
  await act(async () => {});
  expect(summaries()).toEqual(['search "Q3 invoice" → 5 hits', 'read schema']);
  expect(screen.getAllByRole('listitem')[0]).toHaveTextContent('ChatGPT ·');
  expect(screen.getAllByRole('listitem')[1]).toHaveTextContent('Claude Code ·');
});

test('live batches land on top and the list stays capped', async () => {
  mount(Promise.resolve([rec('first')]));
  await act(async () => {});
  act(() => {
    push!(
      Array.from({ length: MCP_ACTIVITY_RECENT_MAX }, (_, i) => rec(`n${i}`)),
    );
  });
  const all = summaries();
  expect(all).toHaveLength(MCP_ACTIVITY_RECENT_MAX);
  expect(all[0]).toBe(`n${MCP_ACTIVITY_RECENT_MAX - 1}`);
  expect(all).not.toContain('first');
});

test('a failed seed still shows live rows', async () => {
  mount(Promise.reject(new Error('no file')));
  await act(async () => {});
  act(() => push!([rec('live one')]));
  expect(summaries()).toEqual(['live one']);
});

test('an error row is red and expands to the error; titles show on expand', async () => {
  mount(
    Promise.resolve([
      rec('fetched 1 document(s)', {
        tool: 'get',
        detail: ['Logo directions — call notes'],
      }),
      rec('ran SQL → error', {
        ok: false,
        error: 'no such column: sender',
      }),
      rec('read schema'),
    ]),
  );
  await act(async () => {});
  const [plain, failed, fetched] = screen.getAllByRole('listitem');
  expect(within(plain).queryByRole('button')).toBeNull();
  expect(failed).toHaveClass('is-err');
  expect(screen.queryByText('no such column: sender')).toBeNull();
  fireEvent.click(within(failed).getByRole('button'));
  expect(screen.getByText('no such column: sender')).toBeInTheDocument();
  fireEvent.click(within(fetched).getByRole('button'));
  expect(screen.getByText('Logo directions — call notes')).toBeInTheDocument();
  expect(within(fetched).getByRole('button')).toHaveAttribute(
    'aria-expanded',
    'true',
  );
});

test('says so when nothing has been asked yet', async () => {
  mount(Promise.resolve([]));
  await act(async () => {});
  expect(screen.getByText(/No requests yet/)).toBeInTheDocument();
  expect(screen.getByRole('region', { name: 'Requests' })).toBeInTheDocument();
});
