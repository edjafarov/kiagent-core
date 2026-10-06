import '@testing-library/jest-dom';
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { AppPrefs, LaneState } from '@shared/contracts';
import type { Invokes } from '@shared/ipc';
import { LocalProcessing, pausedLine } from '../LocalProcessing';

it('says "this Mac" on macOS and "this computer" elsewhere', () => {
  const platform = jest.spyOn(navigator, 'platform', 'get');
  try {
    platform.mockReturnValue('MacIntel');
    expect(pausedLine('until-idle')).toBe(
      'Paused — waiting for this Mac to be idle.',
    );
    platform.mockReturnValue('Win32');
    expect(pausedLine('until-idle')).toBe(
      'Paused — waiting for this computer to be idle.',
    );
  } finally {
    platform.mockRestore();
  }
});

it.each([
  ['open lane shows nothing', 'open', null],
  [
    'idle window, user active',
    'until-idle',
    'Paused — waiting for this computer to be idle.',
  ],
  [
    'night window, daytime',
    'until-night',
    'Paused — runs overnight (22:00–07:00).',
  ],
  ['on battery', 'battery', 'Paused — on battery power.'],
  [
    'processing disabled',
    'disabled',
    'Off — background processing is turned off.',
  ],
] as const)('%s', (_n, lane, want) => {
  expect(pausedLine(lane)).toBe(want);
});

/**
 * Component coverage: the status line, the stats read kept off the 2s
 * download poll (mount and after this pane's own pref writes only), and
 * providers shown only when one needs the user.
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

/** The pushed app-state processing slice the status line reads. */
const mockLive: { waiting: number | null; lane: LaneState } = {
  waiting: 3,
  lane: 'open',
};

jest.mock('@renderer/state/app-state', () => ({
  useAppState: (sel: (s: unknown) => unknown) =>
    sel({ prefs: mockPrefs, processing: mockLive }),
}));

const invoke = jest.fn();

beforeEach(() => {
  invoke.mockReset();
  mockPrefs.processing = { enabled: true, window: 'always' };
  mockPrefs.models = { override: 'auto', autoInstall: true };
  mockLive.waiting = 3;
  mockLive.lane = 'open';
  (window as unknown as { kiagent: unknown }).kiagent = {
    invoke,
    on: () => () => {},
  };
});

function statsRes(overrides: Partial<StatsRes> = {}): StatsRes {
  return {
    processed: 7,
    recent: [],
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
    remote: false,
    installable: true,
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
    routes?: Array<{ task: string; providerName: string; remote: boolean }>;
  } = {},
): void {
  const providers = opts.providers ?? [];
  const stats = opts.stats ?? statsRes();
  const models = opts.models ?? modelsRes();
  invoke.mockImplementation((channel: string) => {
    if (channel === 'inference:providers') return Promise.resolve(providers);
    if (channel === 'inference:stats') return Promise.resolve(stats);
    if (channel === 'inference:models') return Promise.resolve(models);
    if (channel === 'inference:routes')
      return Promise.resolve(opts.routes ?? []);
    return Promise.reject(new Error(`unexpected channel ${channel}`));
  });
}

const READY_LINE = 'Ready · 3 items waiting · 7 read or transcribed so far';

describe('LocalProcessing: status line', () => {
  test('shows a Busy placeholder until stats resolve, then the status line', async () => {
    let resolveStats: (v: StatsRes) => void = () => {};
    const pending = new Promise<StatsRes>((resolve) => {
      resolveStats = resolve;
    });
    mockInvoke({ stats: pending });

    render(<LocalProcessing />);

    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent('Loading processing status…');

    resolveStats(statsRes({ processed: 7 }));

    expect(await screen.findByText(READY_LINE)).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  test('shows the pushed waiting count', async () => {
    mockLive.waiting = 12;
    mockInvoke({ stats: statsRes() });
    render(<LocalProcessing />);
    expect(
      await screen.findByText(
        'Ready · 12 items waiting · 7 read or transcribed so far',
      ),
    ).toBeInTheDocument();
  });

  test('a null pushed waiting count keeps the loading treatment', async () => {
    mockLive.waiting = null;
    mockInvoke();
    render(<LocalProcessing />);
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Loading processing status…',
    );
    expect(screen.queryByText(/items waiting/)).not.toBeInTheDocument();
  });

  test.each([
    ['battery', 'Paused — on battery power · 0 items waiting'],
    ['disabled', 'Off — background processing is turned off · 0 items waiting'],
  ] as const)(
    'a closed lane (%s) is never Ready, even with nothing waiting',
    async (lane, want) => {
      mockLive.lane = lane;
      mockLive.waiting = 0;
      mockInvoke();
      render(<LocalProcessing />);
      expect(
        await screen.findByText(new RegExp(`^${want}`)),
      ).toBeInTheDocument();
      expect(screen.queryByText(/^Ready/)).not.toBeInTheDocument();
    },
  );

  test('a closed lane with work waiting says why it is paused', async () => {
    mockLive.lane = 'until-night';
    mockLive.waiting = 1;
    mockInvoke();
    render(<LocalProcessing />);
    expect(
      await screen.findByText(
        'Paused — runs overnight (22:00–07:00) · 1 item waiting · 7 read or transcribed so far',
      ),
    ).toBeInTheDocument();
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
      // Flush the mount effect's invoke().then().catch() chains.
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
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });
    }

    // 1 (mount) + 3 (one per 2s tick advanced above).
    expect(countOf('inference:providers')).toBe(4);
    expect(countOf('inference:stats')).toBe(1);
  });
});

describe('LocalProcessing: settings', () => {
  test('a pref write re-reads stats and the model catalog once it lands', async () => {
    mockInvoke();
    invoke.mockImplementation((channel: string) => {
      if (channel === 'inference:providers') return Promise.resolve([]);
      if (channel === 'inference:stats') return Promise.resolve(statsRes());
      if (channel === 'inference:models') return Promise.resolve(modelsRes());
      if (channel === 'prefs:patch') return Promise.resolve(undefined);
      return Promise.reject(new Error(`unexpected channel ${channel}`));
    });
    render(<LocalProcessing />);
    await screen.findByText(READY_LINE);
    invoke.mockClear();

    await act(async () => {
      fireEvent.click(screen.getByRole('tab', { name: 'At night' }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(invoke).toHaveBeenCalledWith('prefs:patch', {
      processing: { enabled: true, window: 'night' },
    });
    expect(invoke).toHaveBeenCalledWith('inference:stats', undefined);
    expect(invoke).toHaveBeenCalledWith('inference:models', undefined);
    // A model change can change which provider needs a download.
    expect(invoke).toHaveBeenCalledWith('inference:providers', undefined);
  });

  test('When to run is disabled while processing is off', async () => {
    mockPrefs.processing = { enabled: false, window: 'idle' };
    mockInvoke();
    render(<LocalProcessing />);
    await screen.findByText(/items waiting/);
    expect(screen.getByRole('tab', { name: 'At night' })).toBeDisabled();
  });
});

describe('LocalProcessing: providers only when one needs the user', () => {
  test('healthy providers are not listed; the footnote says so', async () => {
    mockInvoke({
      providers: [
        {
          id: 'local-llm',
          supports: [],
          status: 'ready',
          remote: false,
          installable: true,
        },
        {
          id: 'local-asr',
          supports: ['hear'],
          status: 'standby',
          remote: false,
          installable: true,
        },
      ],
    });
    render(<LocalProcessing />);
    await screen.findByText(READY_LINE);
    expect(
      screen.queryByRole('list', { name: 'Providers that need you' }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(/only appear here when one needs attention/),
    ).toBeInTheDocument();
  });

  test('a standby model with automatic download off offers Download now for THAT provider', async () => {
    mockPrefs.models = { override: 'auto', autoInstall: false };
    mockInvoke({
      providers: [
        {
          id: 'local-asr',
          supports: ['hear'],
          status: 'standby',
          remote: false,
          installable: true,
        },
      ],
    });
    render(<LocalProcessing />);

    const button = await screen.findByRole('button', {
      name: /download now/i,
    });

    await act(async () => {
      fireEvent.click(button);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(invoke).toHaveBeenCalledWith('inference:install', {
      providerId: 'local-asr',
    });
  });

  test('with automatic download on, a standby model can still be fetched from the Model section', async () => {
    mockInvoke({
      providers: [
        {
          id: 'local-llm',
          supports: [],
          status: 'standby',
          remote: false,
          installable: true,
        },
      ],
    });
    render(<LocalProcessing />);
    await screen.findByText(READY_LINE);
    expect(
      screen.queryByRole('list', { name: 'Providers that need you' }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^Model/ }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Download now' }));
      await Promise.resolve();
    });
    expect(invoke).toHaveBeenCalledWith('inference:install', {
      providerId: 'local-llm',
    });
  });

  test('a non-installable provider in error is shown with NO install/retry control', async () => {
    mockInvoke({
      providers: [
        {
          id: 'apple-vision',
          supports: ['read'],
          status: { error: 'x' },
          remote: false,
          installable: false,
        },
      ],
    });
    render(<LocalProcessing />);

    await screen.findByText('Vision (built in)');

    expect(
      screen.queryByRole('button', { name: /retry|download now|cancel/i }),
    ).not.toBeInTheDocument();
  });

  test('windows-ocr without a language shows the language + restart guidance', async () => {
    mockInvoke({
      providers: [
        {
          id: 'windows-ocr',
          supports: ['read'],
          status: {
            error:
              'No text-recognition language is installed. Add a language in Windows Settings → Time & language → Language & region (one with Optical character recognition), then restart KIAgent.',
          },
          remote: false,
          installable: false,
        },
      ],
    });
    render(<LocalProcessing />);
    await screen.findByText('Text recognition (Windows)');
    expect(screen.getByText(/then restart KIAgent/)).toBeInTheDocument();
  });

  test('a downloading provider shows Cancel and its progress', async () => {
    mockInvoke({
      providers: [
        {
          id: 'local-asr',
          supports: ['hear'],
          status: { downloading: { pct: 40 } },
          remote: false,
          installable: true,
        },
      ],
    });
    render(<LocalProcessing />);

    await screen.findByRole('button', { name: /cancel/i });

    expect(
      screen.getByRole('progressbar', { name: 'Speech model download' }),
    ).toHaveAttribute('aria-valuenow', '40');
  });
});

describe('LocalProcessing: recently processed', () => {
  test('summary names the last item; rows carry the engine labels', async () => {
    mockInvoke({
      stats: statsRes({
        recent: [
          {
            id: 'd1',
            title: 'voice memo',
            filename: null,
            type: 'audio',
            engine: 'local-asr',
            updatedAt: new Date().toISOString(),
          },
          {
            id: 'd2',
            title: 'scan',
            filename: null,
            type: 'doc',
            engine: 'local-ocr+vlm',
            updatedAt: new Date().toISOString(),
          },
          {
            id: 'd3',
            title: 'plain scan',
            filename: null,
            type: 'doc',
            engine: 'local-ocr',
            updatedAt: new Date().toISOString(),
          },
        ],
      }),
    });
    render(<LocalProcessing />);

    expect(await screen.findByText(/last: voice memo/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Recently processed/ }));
    expect(screen.getByText('Transcript')).toBeInTheDocument();
    expect(screen.getByText('OCR + description')).toBeInTheDocument();
    expect(screen.getByText('OCR')).toBeInTheDocument();
  });
});

describe('LocalProcessing: tasks routed off this computer', () => {
  test('no routes: nothing leaves it', async () => {
    mockInvoke();
    render(<LocalProcessing />);
    expect(await screen.findByText(/Nothing leaves it\./)).toBeInTheDocument();
    expect(screen.queryByText(/Some tasks are sent to/)).toBeNull();
  });

  test('a route names its provider and qualifies the promise', async () => {
    mockInvoke({
      routes: [
        { task: 'task.a', providerName: 'Remote', remote: true },
        { task: 'task.b', providerName: 'Remote', remote: true },
      ],
    });
    render(<LocalProcessing />);
    expect(
      await screen.findByText(
        /Nothing else leaves it\. Some tasks are sent to Remote\./,
      ),
    ).toBeInTheDocument();
  });
});
