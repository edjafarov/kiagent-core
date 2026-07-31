import '@testing-library/jest-dom';
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { AppPrefs } from '@shared/contracts';
import type { Invokes } from '@shared/ipc';
import { LocalProcessing, pausedLine } from '../LocalProcessing';

it.each([
  ['open lane shows nothing', 'open', 12, null],
  ['empty queue shows nothing even when closed', 'until-idle', 0, null],
  [
    'idle window, user active',
    'until-idle',
    1700,
    'Paused — waiting for this Mac to be idle.',
  ],
  [
    'night window, daytime',
    'until-night',
    3,
    'Paused — runs overnight (22:00–07:00).',
  ],
  ['on battery', 'battery', 3, 'Paused — on battery power.'],
  [
    'processing disabled',
    'disabled',
    3,
    'Paused — background processing is turned off.',
  ],
] as const)('%s', (_n, lane, queued, want) => {
  expect(pausedLine(lane, queued)).toBe(want);
});

/**
 * Component coverage for the stats loading state and its decoupling from
 * the 2s download poll (`loadProviders` no longer fetches `inference:stats`
 * — that's `loadStats`, run on mount and Refresh only).
 */

type ProviderRow = Invokes['inference:providers']['res'][number];
type StatsRes = Invokes['inference:stats']['res'];
type ModelsRes = Invokes['inference:models']['res'];

const mockPrefs: {
  processing: AppPrefs['processing'];
  models: AppPrefs['models'];
} = {
  processing: { enabled: true, window: 'always' },
  models: { override: 'auto', autoInstall: true },
};

jest.mock('@renderer/state/app-state', () => ({
  useAppState: (sel: (s: unknown) => unknown) => sel({ prefs: mockPrefs }),
}));

const invoke = jest.fn();

beforeEach(() => {
  invoke.mockReset();
  mockPrefs.processing = { enabled: true, window: 'always' };
  mockPrefs.models = { override: 'auto', autoInstall: true };
  (window as unknown as { kiagent: unknown }).kiagent = {
    invoke,
    on: () => () => {},
  };
});

function statsRes(overrides: Partial<StatsRes> = {}): StatsRes {
  return {
    pendingOcr: 3,
    processed: 7,
    recent: [],
    lane: 'open',
    ...overrides,
  };
}

function modelsRes(): ModelsRes {
  return { options: [], selectedId: 'auto' };
}

function downloadingProvider(): ProviderRow {
  return {
    id: 'local-llm',
    supports: [],
    status: { downloading: { pct: 50 } },
  };
}

/** Wires `invoke` per-channel. `stats` may be a plain value OR a pending
 *  Promise (Promise.resolve() on an already-genuine Promise returns the
 *  same instance), so tests can hold `inference:stats` unresolved. */
function mockInvoke(
  opts: {
    providers?: ProviderRow[];
    stats?: StatsRes | Promise<StatsRes>;
    models?: ModelsRes;
  } = {},
): void {
  const providers = opts.providers ?? [];
  const stats = opts.stats ?? statsRes();
  const models = opts.models ?? modelsRes();
  invoke.mockImplementation((channel: string) => {
    if (channel === 'inference:providers') return Promise.resolve(providers);
    if (channel === 'inference:stats') return Promise.resolve(stats);
    if (channel === 'inference:models') return Promise.resolve(models);
    return Promise.reject(new Error(`unexpected channel ${channel}`));
  });
}

describe('LocalProcessing: stats loading state', () => {
  test('shows a Busy placeholder until stats resolve, then the queued line', async () => {
    let resolveStats: (v: StatsRes) => void = () => {};
    const pending = new Promise<StatsRes>((resolve) => {
      resolveStats = resolve;
    });
    mockInvoke({ stats: pending });

    render(<LocalProcessing />);

    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent('Loading processing status…');
    expect(screen.queryByText(/queued for processing/)).not.toBeInTheDocument();

    resolveStats(statsRes({ pendingOcr: 3, processed: 7 }));

    expect(
      await screen.findByText('3 queued for processing · 7 processed'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});

describe('LocalProcessing: stats off the download poll', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('the 2s poll re-invokes providers while stats is fetched once, on mount', async () => {
    mockInvoke({ providers: [downloadingProvider()] });

    await act(async () => {
      render(<LocalProcessing />);
      // Flush the mount effect's invoke().then().catch().finally() chains
      // (each link is its own microtask tick).
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const countOf = (channel: string) =>
      invoke.mock.calls.filter(([c]) => c === channel).length;

    expect(countOf('inference:providers')).toBe(1);
    expect(countOf('inference:stats')).toBe(1);

    for (let i = 0; i < 3; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await act(async () => {
        await jest.advanceTimersByTimeAsync(2000);
        // Flush the re-triggered invoke().then().catch().finally() chain.
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });
    }

    expect(countOf('inference:providers')).toBeGreaterThan(1);
    expect(countOf('inference:stats')).toBe(1);
  });
});

describe('LocalProcessing: Refresh', () => {
  test('Refresh re-invokes both providers and stats', async () => {
    mockInvoke();
    render(<LocalProcessing />);

    await screen.findByText('3 queued for processing · 7 processed');
    invoke.mockClear();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /refresh/i }));
      // Flush the re-triggered invoke().then().catch().finally() chains.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(invoke).toHaveBeenCalledWith('inference:providers', undefined);
    expect(invoke).toHaveBeenCalledWith('inference:stats', undefined);
  });
});
