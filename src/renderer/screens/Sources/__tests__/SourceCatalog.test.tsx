import '@testing-library/jest-dom';
import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import type { AppState, ExtensionSnapshot } from '@shared/contracts';
import { ViewContext, type ViewContextValue } from '@renderer/state/view';
import { invalidateStoreListing } from '@renderer/extensions/store-listing';
import { SourceCatalog } from '../SourceCatalog';
import { SourceDescriptorsProvider } from '../sources-registry';
import { Sources } from '..';

let mockState: Partial<AppState>;
jest.mock('@renderer/state/app-state', () => ({
  useAppState: (sel: (s: unknown) => unknown) => sel(mockState),
}));

const GMAIL = { id: 'gmail', name: 'Gmail', documentTypes: [], auth: 'oauth' };
const SLACK = { id: 'slack', name: 'Slack', documentTypes: [], auth: 'oauth' };
const DROPBOX = {
  id: 'dropbox',
  name: 'Dropbox',
  documentTypes: [],
  auth: 'oauth',
};
const ITEMS = [
  {
    owner: 'example-org',
    repo: 'dropbox-kia-connector',
    fullName: 'example-org/dropbox-kia-connector',
    displayName: 'Dropbox',
    description: 'Files and folders from Dropbox',
  },
  {
    owner: 'example-org',
    repo: 'linear-kia-connector',
    fullName: 'example-org/linear-kia-connector',
    displayName: 'Linear',
    description: 'Issues and comments',
  },
];
const PREVIEW = {
  ok: true,
  token: 't1',
  id: 'dropbox-ext',
  name: 'Dropbox',
  version: '1.0.3',
  caps: ['net'],
  oauthSources: [],
  ui: [],
  sourceIds: ['dropbox'],
  sizeBytes: 1024,
  integrity: null,
  ref: 'github:example-org/dropbox-kia-connector@v1.0.3',
};

let descriptors: unknown[];
let invoke: jest.Mock;

function dropboxExt(status: ExtensionSnapshot['status']): ExtensionSnapshot {
  return {
    id: 'dropbox-ext',
    name: 'Dropbox',
    version: '1.0.3',
    origin: 'marketplace',
    enabled: true,
    status,
    error: status === 'errored' ? 'boom' : undefined,
    caps: ['net'],
    sourceIds: ['dropbox'],
    oauthSources: [],
    ref: 'github:example-org/dropbox-kia-connector',
    activatedAt: status === 'activated' ? '2026-09-27T10:00:00Z' : undefined,
  };
}

beforeEach(() => {
  invalidateStoreListing();
  descriptors = [GMAIL, SLACK];
  mockState = {
    extensions: [],
    accounts: [
      {
        account: { id: 'a1', source: 'slack', identifier: 'team' },
        docCount: 1,
        recent: [],
      },
    ],
    ready: true,
  } as unknown as Partial<AppState>;
  invoke = jest.fn((channel: string) => {
    if (channel === 'sources:list') return Promise.resolve(descriptors);
    if (channel === 'marketplace:list') return Promise.resolve(ITEMS);
    if (channel === 'extension:install-preview')
      return Promise.resolve(PREVIEW);
    if (channel === 'extension:install-commit')
      return Promise.resolve({ ok: true, id: 'dropbox-ext' });
    return Promise.resolve(undefined);
  });
  (window as unknown as { kiagent: unknown }).kiagent = {
    invoke,
    on: jest.fn(() => () => {}),
  };
});

function catalog(props: Partial<React.ComponentProps<typeof SourceCatalog>>) {
  const onPick = props.onPick ?? jest.fn();
  const ui = () => (
    <SourceDescriptorsProvider>
      <SourceCatalog onBack={jest.fn()} onPick={onPick} {...props} />
    </SourceDescriptorsProvider>
  );
  const r = render(ui());
  return { onPick, rerender: () => r.rerender(ui()) };
}

function section(name: string): HTMLElement {
  return screen.getByRole('region', { name });
}

describe('SourceCatalog', () => {
  test('lists sources, then what the store adds, each with its footer', async () => {
    catalog({});
    await act(async () => {});
    const sources = section('Sources');
    expect(within(sources).getByText('Gmail')).toBeInTheDocument();
    expect(within(sources).getByText('Built in')).toBeInTheDocument();
    expect(within(sources).getByText('1 connected')).toBeInTheDocument();
    const store = section('From the store');
    expect(within(store).getByText('Dropbox')).toBeInTheDocument();
    expect(within(store).getAllByText('Install')).toHaveLength(2);
    expect(
      screen.getByRole('heading', { name: 'Add a source' }),
    ).toBeInTheDocument();
  });

  test('search narrows both sections and says when nothing matches', async () => {
    catalog({});
    await act(async () => {});
    const search = screen.getByRole('searchbox', {
      name: 'Search sources and extensions',
    });
    fireEvent.change(search, { target: { value: 'issues' } });
    expect(screen.queryByRole('region', { name: 'Sources' })).toBeNull();
    expect(
      within(section('From the store')).getByText('Linear'),
    ).toBeInTheDocument();
    fireEvent.change(search, { target: { value: 'zzz' } });
    expect(screen.getByText('Nothing matches “zzz”.')).toBeInTheDocument();
  });

  test('a source tile picks that source', async () => {
    const { onPick } = catalog({});
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: /Gmail/ }));
    expect(onPick).toHaveBeenCalledWith('gmail');
  });

  test('a store tile opens the install sheet with its store description', async () => {
    catalog({});
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: /Dropbox/ }));
    await act(async () => {});
    expect(invoke).toHaveBeenCalledWith('extension:install-preview', {
      ref: 'github:example-org/dropbox-kia-connector',
    });
    const sheet = screen.getByRole('dialog');
    expect(
      within(sheet).getByText('Files and folders from Dropbox'),
    ).toBeInTheDocument();
    expect(
      within(sheet).getByRole('button', { name: 'Install & connect' }),
    ).toBeInTheDocument();
  });

  test('install & connect picks the new source once it runs and is listed', async () => {
    const { onPick, rerender } = catalog({});
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: /Dropbox/ }));
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'Install & connect' }));
    await act(async () => {});
    expect(screen.getByRole('status')).toHaveTextContent('Installing Dropbox…');

    mockState = { ...mockState, extensions: [dropboxExt('activating')] };
    rerender();
    await act(async () => {});
    expect(onPick).not.toHaveBeenCalled();

    descriptors = [GMAIL, SLACK, DROPBOX];
    mockState = { ...mockState, extensions: [dropboxExt('activated')] };
    rerender();
    await act(async () => {});
    expect(onPick).toHaveBeenCalledWith('dropbox');
  });

  test('an extension that fails to start drops the connect and says why', async () => {
    const { onPick, rerender } = catalog({});
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: /Dropbox/ }));
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'Install & connect' }));
    await act(async () => {});
    mockState = { ...mockState, extensions: [dropboxExt('errored')] };
    rerender();
    await act(async () => {});
    expect(onPick).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent(
      'Dropbox was installed but couldn’t start: boom',
    );
  });

  test('an extension that lands turned off drops the connect too', async () => {
    const { onPick, rerender } = catalog({});
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: /Dropbox/ }));
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'Install & connect' }));
    await act(async () => {});
    mockState = { ...mockState, extensions: [dropboxExt('disabled')] };
    rerender();
    await act(async () => {});
    expect(onPick).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent(
      'Dropbox was installed and is turned off in Settings.',
    );
    expect(screen.getByRole('button', { name: /Gmail/ })).toBeEnabled();
  });

  describe('Add from GitHub', () => {
    function withLink(link?: { text: string; seq: number }) {
      const ui = (l?: { text: string; seq: number }) => (
        <SourceDescriptorsProvider>
          <SourceCatalog onBack={jest.fn()} onPick={jest.fn()} link={l} />
        </SourceDescriptorsProvider>
      );
      const r = render(ui(link));
      return (l?: { text: string; seq: number }) => r.rerender(ui(l));
    }
    const addSheet = () =>
      screen.queryByRole('dialog', { name: 'Add from GitHub' });

    test('the row shows even when the store could not be reached', async () => {
      invoke.mockImplementation((channel: string) =>
        channel === 'sources:list'
          ? Promise.resolve(descriptors)
          : Promise.reject(new Error('offline')),
      );
      catalog({});
      await act(async () => {});
      expect(
        screen.getByText('Have a link to a connector?'),
      ).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Add from GitHub…' }));
      expect(addSheet()).toBeInTheDocument();
    });

    test('a preview error stays in the Add sheet; success moves to the consent sheet', async () => {
      invoke.mockImplementation((channel: string) => {
        if (channel === 'sources:list') return Promise.resolve(descriptors);
        if (channel === 'marketplace:list') return Promise.resolve(ITEMS);
        if (channel === 'extension:install-preview')
          return Promise.resolve({
            ok: false,
            error: 'This repository has no release to install yet.',
          });
        return Promise.resolve(undefined);
      });
      catalog({});
      await act(async () => {});
      fireEvent.click(screen.getByRole('button', { name: 'Add from GitHub…' }));
      fireEvent.change(screen.getByLabelText('Repository'), {
        target: { value: 'o/r' },
      });
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
      });
      expect(invoke).toHaveBeenCalledWith('extension:install-preview', {
        ref: 'github:o/r',
      });
      expect(within(addSheet()!).getByRole('alert')).toHaveTextContent(
        'This repository has no release to install yet.',
      );
      invoke.mockImplementation((channel: string) =>
        channel === 'extension:install-preview'
          ? Promise.resolve({ ...PREVIEW, ref: 'github:o/r@v1' })
          : Promise.resolve(channel === 'sources:list' ? descriptors : ITEMS),
      );
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
      });
      expect(addSheet()).toBeNull();
      expect(screen.getByRole('note')).toHaveTextContent(
        'Not reviewed by KIAgent',
      );
    });

    test('closing the sheet after a failed Continue leaves no error on the catalog', async () => {
      invoke.mockImplementation((channel: string) => {
        if (channel === 'sources:list') return Promise.resolve(descriptors);
        if (channel === 'marketplace:list') return Promise.resolve(ITEMS);
        if (channel === 'extension:install-preview')
          return Promise.resolve({ ok: false, error: 'Nope from preview' });
        return Promise.resolve(undefined);
      });
      catalog({});
      await act(async () => {});
      fireEvent.click(screen.getByRole('button', { name: 'Add from GitHub…' }));
      fireEvent.change(screen.getByLabelText('Repository'), {
        target: { value: 'o/r' },
      });
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
      });
      expect(screen.getByText('Nope from preview')).toBeInTheDocument();
      fireEvent.click(
        within(addSheet()!).getByRole('button', { name: 'Cancel' }),
      );
      expect(addSheet()).toBeNull();
      expect(screen.queryByText('Nope from preview')).toBeNull();
    });

    test('a link opens the sheet prefilled, and the same link again reopens it', async () => {
      const update = withLink({ text: 'o/r@v1', seq: 1 });
      await act(async () => {});
      expect(screen.getByLabelText('Repository')).toHaveValue('o/r@v1');
      expect(invoke).not.toHaveBeenCalledWith(
        'extension:install-preview',
        expect.anything(),
      );
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(addSheet()).toBeNull();
      update({ text: 'o/r@v1', seq: 2 });
      await act(async () => {});
      expect(screen.getByLabelText('Repository')).toHaveValue('o/r@v1');
    });

    test('a link is ignored while a consent sheet is open', async () => {
      const update = withLink();
      await act(async () => {});
      fireEvent.click(screen.getByRole('button', { name: /Dropbox/ }));
      await act(async () => {});
      expect(screen.getByRole('dialog')).toBeInTheDocument();
      update({ text: 'o/r', seq: 5 });
      await act(async () => {});
      expect(addSheet()).toBeNull();
    });
  });

  test('an unreachable store says so and can try again', async () => {
    invoke.mockImplementation((channel: string) =>
      channel === 'sources:list'
        ? Promise.resolve(descriptors)
        : Promise.reject(new Error('offline')),
    );
    catalog({});
    await act(async () => {});
    expect(
      screen.getByText(/The store couldn’t be reached/),
    ).toBeInTheDocument();
    invoke.mockImplementation((channel: string) =>
      Promise.resolve(channel === 'sources:list' ? descriptors : ITEMS),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await act(async () => {});
    expect(
      within(section('From the store')).getByText('Dropbox'),
    ).toBeInTheDocument();
  });
});

describe('Sources: links', () => {
  function at(params: ViewContextValue['params']) {
    const replaceParams = jest.fn();
    const ctx: ViewContextValue = {
      view: 'sources',
      params,
      navigate: jest.fn(),
      back: jest.fn(),
      openSettings: jest.fn(),
      replaceParams,
    };
    render(
      <ViewContext.Provider value={ctx}>
        <SourceDescriptorsProvider hidden={['slack']}>
          <Sources onOpenConnection={jest.fn()} />
        </SourceDescriptorsProvider>
      </ViewContext.Provider>,
    );
    return replaceParams;
  }

  test('add= opens the catalog, minus hidden sources, and clears the param', async () => {
    const replaceParams = at({ add: '' });
    await act(async () => {});
    expect(
      screen.getByRole('heading', { name: 'Add a source' }),
    ).toBeInTheDocument();
    expect(
      within(section('Sources')).queryByText('Slack'),
    ).not.toBeInTheDocument();
    expect(replaceParams).toHaveBeenCalledWith({});
  });

  test('add=<source> starts that source’s connect flow', async () => {
    at({ add: 'gmail' });
    await act(async () => {});
    expect(invoke).toHaveBeenCalledWith('accounts:add', { sourceId: 'gmail' });
    expect(screen.getByRole('heading', { name: 'Gmail' })).toBeInTheDocument();
  });

  test('install=<owner/repo> opens the catalog with that install sheet', async () => {
    at({ install: 'example-org/dropbox-kia-connector' });
    await act(async () => {});
    expect(invoke).toHaveBeenCalledWith('extension:install-preview', {
      ref: 'github:example-org/dropbox-kia-connector',
    });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  test('link=<owner/repo@tag> opens the catalog with the Add sheet prefilled, fetching nothing', async () => {
    at({ add: '', link: 'o/r@v1', linkSeq: '4' });
    await act(async () => {});
    expect(
      screen.getByRole('dialog', { name: 'Add from GitHub' }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Repository')).toHaveValue('o/r@v1');
    expect(invoke).not.toHaveBeenCalledWith(
      'extension:install-preview',
      expect.anything(),
    );
  });
});
