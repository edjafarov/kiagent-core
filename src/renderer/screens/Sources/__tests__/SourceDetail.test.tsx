import '@testing-library/jest-dom';
import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import type { Account, AppState, SourceDescriptor } from '@shared/contracts';
import { SourceDetail } from '../SourceDetail';

let mockState: Partial<AppState>;
let mockDescriptors: SourceDescriptor[] | null;

jest.mock('@renderer/state/app-state', () => ({
  useAppState: (sel: (s: unknown) => unknown) => sel(mockState),
}));
jest.mock('../sources-registry', () => ({
  useSourceDescriptors: () => mockDescriptors,
  useVisibleAccounts: () => mockState.accounts ?? [],
}));
const mockTrackedContent = jest.fn(() => <div data-testid="items" />);

// Every other section is exercised by its own surface; this test is about
// SourceDetail's COMPOSITION — which sections and affordances appear at which
// descriptor/status.
jest.mock('../sections/TrackedContent', () => ({
  TrackedContent: () => mockTrackedContent(),
}));
jest.mock('../sections/Cadence', () => ({ Cadence: () => <div /> }));
jest.mock('../sections/ConnectorConfig', () => ({
  ConnectorConfig: () => <div />,
}));
jest.mock('../sections/Outbound', () => ({ Outbound: () => <div /> }));
jest.mock('../sections/RecentActivity', () => ({
  RecentActivity: () => <div />,
}));
jest.mock('../sections/TrackedFolders', () => ({
  TrackedFolders: () => <div data-testid="tracked-folders" />,
  folderRoots: () => [{ id: 'root', name: 'My Drive' }],
}));
jest.mock('../AddSourcePanel', () => ({
  AddSourcePanel: (p: { reconnect?: unknown }) => (
    <div data-testid="add-source-panel">{JSON.stringify(p.reconnect)}</div>
  ),
}));

function setAccount(status: Account['status']): void {
  const account: Account = {
    id: 'a1' as Account['id'],
    source: 'google-docs',
    identifier: 'user@example.com',
    config: { folderRoots: [{ id: 'root', name: 'My Drive' }] },
    status,
    cursor: null,
    createdAt: '2026-01-01T00:00:00Z',
  };
  mockState = {
    accounts: [{ account, docCount: 3, recent: [] }],
  } as unknown as Partial<AppState>;
}

const SCOPED: SourceDescriptor[] = [
  {
    id: 'google-docs',
    name: 'Google Drive',
    documentTypes: ['gdoc'],
    auth: 'oauth',
    folderScope: true,
  },
];
const UNSCOPED: SourceDescriptor[] = [
  {
    id: 'google-docs',
    name: 'Google Drive',
    documentTypes: ['gdoc'],
    auth: 'oauth',
  },
];

const noop = (): void => {};

beforeEach(() => {
  (window as unknown as { kiagent: unknown }).kiagent = {
    invoke: jest.fn(() => Promise.resolve(undefined)),
    on: jest.fn(() => () => {}),
  };
  setAccount('live');
  mockDescriptors = SCOPED;
});

describe('SourceDetail: the Tracked folders gate is the descriptor', () => {
  it('renders the card for a folderScope descriptor', () => {
    render(<SourceDetail accountId={'a1' as Account['id']} onBack={noop} />);
    expect(screen.getByTestId('tracked-folders')).toBeInTheDocument();
  });

  it('renders no card for a descriptor without folderScope', () => {
    mockDescriptors = UNSCOPED;
    render(<SourceDetail accountId={'a1' as Account['id']} onBack={noop} />);
    expect(screen.queryByTestId('tracked-folders')).not.toBeInTheDocument();
  });

  it('renders no card while descriptors are still loading', () => {
    mockDescriptors = null;
    render(<SourceDetail accountId={'a1' as Account['id']} onBack={noop} />);
    expect(screen.queryByTestId('tracked-folders')).not.toBeInTheDocument();
  });

  it('renders no card when the descriptor list failed and came back empty', () => {
    mockDescriptors = [];
    render(<SourceDetail accountId={'a1' as Account['id']} onBack={noop} />);
    expect(screen.queryByTestId('tracked-folders')).not.toBeInTheDocument();
  });
});

describe('SourceDetail: Sign in again (R4 — needsReauth and error only)', () => {
  it('a healthy account offers no Sign in again', () => {
    render(<SourceDetail accountId={'a1' as Account['id']} onBack={noop} />);
    expect(
      screen.queryByRole('button', { name: 'Sign in again' }),
    ).not.toBeInTheDocument();
  });

  it('a needsReauth account offers Sign in again', () => {
    setAccount('needsReauth');
    render(<SourceDetail accountId={'a1' as Account['id']} onBack={noop} />);
    expect(
      screen.getByRole('button', { name: 'Sign in again' }),
    ).toBeInTheDocument();
  });

  it('an error account offers Retry and Sign in again', () => {
    setAccount('error');
    render(<SourceDetail accountId={'a1' as Account['id']} onBack={noop} />);
    expect(
      screen.getByRole('button', { name: 'Sign in again' }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(
      (window as unknown as { kiagent: { invoke: jest.Mock } }).kiagent.invoke,
    ).toHaveBeenCalledWith('accounts:sync-now', { accountId: 'a1' });
  });

  it('Sign in again mounts AddSourcePanel with THIS account’s identity', () => {
    setAccount('needsReauth');
    render(<SourceDetail accountId={'a1' as Account['id']} onBack={noop} />);
    fireEvent.click(screen.getByRole('button', { name: 'Sign in again' }));

    // Decision 7: SourceDetail never invokes accounts:start-reconnect itself,
    // so it never needs to become an alpha-cent shadow — the panel it renders
    // already is one, and owns the R2 BYO-OAuth gate.
    expect(screen.getByTestId('add-source-panel')).toHaveTextContent(
      JSON.stringify({
        accountId: 'a1',
        sourceId: 'google-docs',
        identifier: 'user@example.com',
      }),
    );
    expect(
      (window as unknown as { kiagent: { invoke: jest.Mock } }).kiagent.invoke,
    ).not.toHaveBeenCalledWith('accounts:start-reconnect', expect.anything());
    expect(screen.queryByTestId('tracked-folders')).not.toBeInTheDocument();
  });
});

describe('SourceDetail: the page', () => {
  const invoke = (): jest.Mock =>
    (window as unknown as { kiagent: { invoke: jest.Mock } }).kiagent.invoke;

  it('names the source in the crumb, which steps back', () => {
    const onBack = jest.fn();
    render(<SourceDetail accountId={'a1' as Account['id']} onBack={onBack} />);
    expect(
      screen.getByRole('heading', { level: 1, name: 'Google Drive' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/^3 items · last item/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Back to Sources' }));
    expect(onBack).toHaveBeenCalled();
  });

  it('a paused source says so and resumes', () => {
    setAccount('paused');
    render(<SourceDetail accountId={'a1' as Account['id']} onBack={noop} />);
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    expect(invoke()).toHaveBeenCalledWith('accounts:resume', {
      accountId: 'a1',
    });
  });

  it('the menu syncs and pauses; Remove lives in its own card', () => {
    render(<SourceDetail accountId={'a1' as Account['id']} onBack={noop} />);
    fireEvent.click(screen.getByRole('button', { name: 'Source actions' }));
    expect(
      screen.queryByRole('menuitem', { name: 'Remove' }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Pause' }));
    expect(invoke()).toHaveBeenCalledWith('accounts:pause', {
      accountId: 'a1',
    });
  });

  it('Browse opens the items as a sub-view with its own way back', () => {
    render(<SourceDetail accountId={'a1' as Account['id']} onBack={noop} />);
    fireEvent.click(screen.getByRole('button', { name: /Browse 3 items/ }));
    expect(screen.getByTestId('items')).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole('button', { name: 'Back to Google Drive' }),
    );
    expect(screen.queryByTestId('items')).not.toBeInTheDocument();
  });

  it('technical details stay closed until asked for', () => {
    render(<SourceDetail accountId={'a1' as Account['id']} onBack={noop} />);
    const toggle = screen.getByRole('button', { name: /Technical details/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
  });

  it('opens straight into signing in again when asked', () => {
    setAccount('needsReauth');
    render(
      <SourceDetail
        accountId={'a1' as Account['id']}
        onBack={noop}
        reconnect
      />,
    );
    expect(screen.getByTestId('add-source-panel')).toBeInTheDocument();
  });

  it('technical details show where the sync has got to', () => {
    render(<SourceDetail accountId={'a1' as Account['id']} onBack={noop} />);
    fireEvent.click(screen.getByRole('button', { name: /Technical details/ }));
    expect(screen.getByText('Not started')).toBeInTheDocument();
  });

  it('Remove asks first, removes, then goes back', async () => {
    const onBack = jest.fn();
    render(<SourceDetail accountId={'a1' as Account['id']} onBack={onBack} />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove…' }));
    const sheet = screen.getByRole('dialog', { name: 'Remove Google Drive?' });
    expect(sheet).toHaveTextContent('Its 3 items are deleted');
    fireEvent.click(within(sheet).getByRole('button', { name: 'Remove' }));
    await act(async () => {});
    expect(invoke()).toHaveBeenCalledWith('accounts:remove', {
      accountId: 'a1',
    });
    expect(onBack).toHaveBeenCalled();
  });

  it('a removed source says so instead of a blank page', () => {
    mockState = { accounts: [] } as unknown as Partial<AppState>;
    render(<SourceDetail accountId={'a1' as Account['id']} onBack={noop} />);
    expect(screen.getByText('This source was removed.')).toBeInTheDocument();
  });
});
