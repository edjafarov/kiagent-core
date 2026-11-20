/** @jest-environment node */
import type { McpTool, Query } from '@shared/contracts';
import {
  collectOverviews,
  makeDigitalMemoryInfoTool,
} from '../digital-memory-info';

const query = {
  accounts: async () => [],
  count: async () => 0,
  search: async () => [],
} as unknown as Query;

const tool = (
  name: string,
  call: McpTool['call'],
  overview = true,
): McpTool => ({
  name,
  description: '',
  inputSchema: {},
  overview,
  call,
});

function setup(initial: McpTool[]) {
  const registry = new Map(initial.map((t) => [t.name, t]));
  const warn = jest.fn();
  const info = makeDigitalMemoryInfoTool(query, () =>
    collectOverviews(registry.values(), warn),
  );
  return { registry, warn, info };
}

describe('digital_memory_info overviews', () => {
  afterEach(() => jest.useRealTimers());

  it('has no `more` key when no tool has an overview', async () => {
    const { info } = setup([tool('plain', async () => 1, false)]);
    expect(await info()).not.toHaveProperty('more');
  });

  it('includes an overview tool result, called with {}', async () => {
    const call = jest.fn(async () => ({ pages: ['a'] }));
    const { info } = setup([tool('memory_list', call)]);
    expect((await info()).more).toEqual({ memory_list: { pages: ['a'] } });
    expect(call).toHaveBeenCalledWith({});
  });

  it('skips a throwing tool and warns without the error result', async () => {
    const { info, warn } = setup([
      tool('bad', async () => {
        throw new Error('boom');
      }),
      tool('good', async () => 'ok'),
    ]);
    expect((await info()).more).toEqual({ good: 'ok' });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('skips a tool that takes longer than 3 seconds', async () => {
    jest.useFakeTimers();
    const { info } = setup([
      tool('slow', () => new Promise(() => {})),
      tool('fast', async () => 1),
    ]);
    const p = info();
    await jest.advanceTimersByTimeAsync(3001);
    expect((await p).more).toEqual({ fast: 1 });
  });

  it('replaces an oversized result with a note', async () => {
    const { info } = setup([tool('big', async () => 'x'.repeat(12_001))]);
    expect((await info()).more).toEqual({
      big: { note: 'Too long to include; call big for it.' },
    });
  });

  it('reads the registry at call time and never recurses into itself', async () => {
    const { info, registry } = setup([]);
    expect(await info()).not.toHaveProperty('more');
    const late = tool('late', async () => 'hi');
    registry.set('late', late);
    registry.set('digital_memory_info', tool('digital_memory_info', info));
    expect((await info()).more).toEqual({ late: 'hi' });
    registry.delete('late');
    expect(await info()).not.toHaveProperty('more');
  });
});
