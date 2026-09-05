import '@testing-library/jest-dom';
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import type { Account, AppState, SourceDescriptor } from '@shared/contracts';
import { SourceDetail } from '../SourceDetail';

let mockState: Partial<AppState>;
let mockDescriptors: SourceDescriptor[] | null;

jest.mock('@renderer/state/app-state', () => ({
  useAppState: (sel: (s: unknown) => unknown) => sel(mockState),
}));
jest.mock('../sources-registry', () => ({
  useSourceDescriptors: () => mockDescriptors,
}));

// Every other section is exercised by its own surface; this test is about
// SourceDetail's COMPOSITION — which sections and affordances appear at which
// descriptor/status.
jest.mock('../sections/Overview', () => ({ Overview: () => <div /> }));
jest.mock('../sections/TrackedContent', () => ({
  TrackedContent: () => <div />,
}));
jest.mock('../sections/Cadence', () => ({ Cadence: () => <div /> }));
jest.mock('../sections/ConnectorConfig', () => ({
  ConnectorConfig: () => <div />,
}));
jest.mock('../sections/Outbound', () => ({ Outbound: () => <div /> }));
jest.mock('../sections/RecentActivity', () => ({
  RecentActivity: () => <div />,
}));
jest.mock('../sections/DangerZone', () => ({ DangerZone: () => <div /> }));
jest.mock('../AccountRowActions', () => ({ AccountRowActions: () => <div /> }));
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

describe('SourceDetail: Reconnect (R4 — needsReauth and error only)', () => {
  it('a healthy account offers no Reconnect', () => {
    render(<SourceDetail accountId={'a1' as Account['id']} onBack={noop} />);
    expect(
      screen.queryByRole('button', { name: 'Reconnect' }),
    ).not.toBeInTheDocument();
  });

  it('a needsReauth account offers Reconnect', () => {
    setAccount('needsReauth');
    render(<SourceDetail accountId={'a1' as Account['id']} onBack={noop} />);
    expect(
      screen.getByRole('button', { name: 'Reconnect' }),
    ).toBeInTheDocument();
  });

  it('an error account offers Reconnect', () => {
    setAccount('error');
    render(<SourceDetail accountId={'a1' as Account['id']} onBack={noop} />);
    expect(
      screen.getByRole('button', { name: 'Reconnect' }),
    ).toBeInTheDocument();
  });

  it('Reconnect mounts AddSourcePanel with THIS account’s identity', () => {
    setAccount('needsReauth');
    render(<SourceDetail accountId={'a1' as Account['id']} onBack={noop} />);
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }));

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
