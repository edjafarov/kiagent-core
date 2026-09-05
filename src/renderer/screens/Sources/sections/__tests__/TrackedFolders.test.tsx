import '@testing-library/jest-dom';
import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import type { Account } from '@shared/contracts';
import {
  TrackedFolders,
  folderRoots,
  isLocalPathRoot,
} from '../TrackedFolders';

jest.mock('@renderer/components/folder-picker/FolderPickerModal', () => ({
  FolderPickerModal: (p: {
    purpose?: string;
    selected?: Array<{ id: string; name: string }>;
    expandIds?: string[];
    onConfirm: (ids: string[]) => void;
    onClose: () => void;
  }) => (
    <div data-testid="picker" data-purpose={p.purpose}>
      <span data-testid="picker-selected">
        {(p.selected ?? []).map((n) => n.id).join(',')}
      </span>
      <span data-testid="picker-expand">{(p.expandIds ?? []).join(',')}</span>
      <button type="button" onClick={() => p.onConfirm(['r1'])}>
        picker-save
      </button>
      <button type="button" onClick={() => p.onClose()}>
        picker-close
      </button>
    </div>
  ),
}));

// `mock`-prefixed so the names stay legal inside a hoisted jest.mock factory.
const mockConfirm = jest.fn((_ids: string[]) => Promise.resolve());
const mockCancel = jest.fn(() => Promise.resolve());

jest.mock('../../connect-picker-adapter', () => ({
  // `pickerRequestFromEvent` is a pure wire-event -> PickerRequest mapping
  // with no I/O, and it is exactly what these tests exercise: keep the REAL
  // one, and fake only the adapter factory below.
  ...jest.requireActual('../../connect-picker-adapter'),
  // Task 5's adapter is the ONE FolderNode[] -> Entry[] conversion point
  // (C-7), so the fake converts too: the component renders
  // `pickerAdapter.selected`, never the wire value. `path` and `hasChildren`
  // are filled because Task 6's modal reads only `id` and `name` off a
  // selected entry. The parameter is annotated inline — ts-jest diagnostics
  // are on, and an implicit `any` here is an error, not a warning.
  createConnectPickerAdapter: (picker: {
    selected?: Array<{ id: string; name: string }>;
    expand?: string[];
  }) => ({
    dataSource: {},
    // Mirrors the real adapter (C-50): ids pass through untouched, and an
    // absent `expand` means "reveal nothing", never `undefined`.
    expandIds: picker.expand ?? [],
    selected: (picker.selected ?? []).map((n) => ({
      id: n.id,
      path: '',
      name: n.name,
      hasChildren: false,
    })),
    confirm: mockConfirm,
    cancel: mockCancel,
  }),
}));

let pushHandler: ((evt: unknown) => void) | null = null;

function invokeMock(): jest.Mock {
  return (window as unknown as { kiagent: { invoke: jest.Mock } }).kiagent
    .invoke;
}

beforeEach(() => {
  pushHandler = null;
  mockConfirm.mockClear();
  mockCancel.mockClear();
  (window as unknown as { kiagent: unknown }).kiagent = {
    invoke: jest.fn((channel: string) => {
      if (channel === 'sources:count-files')
        return Promise.resolve({ count: 12, capped: false });
      if (channel === 'accounts:start-manage-folders')
        return Promise.resolve({ flowId: 'f1' });
      if (channel === 'accounts:cancel-flow') return Promise.resolve(undefined);
      return Promise.reject(new Error(`unexpected invoke: ${channel}`));
    }),
    on: jest.fn((_channel: string, handler: (evt: unknown) => void) => {
      pushHandler = handler;
      return () => {};
    }),
  };
});

function accountWith(
  roots: Array<{ id: string; name: string }>,
  status: Account['status'] = 'live',
  source = 'google-docs',
): Account {
  return {
    id: 'a1' as Account['id'],
    source,
    identifier: 'user@example.com',
    config: { folderRoots: roots },
    status,
    cursor: null,
    createdAt: '2026-01-01T00:00:00Z',
  };
}

describe('folderRoots', () => {
  it('reads canonical folderRoots and drops malformed entries', () => {
    const a = accountWith([]);
    a.config = {
      folderRoots: [
        { id: 'r1', name: 'Reports' },
        { id: '', name: 'empty id' },
        { name: 'no id' },
        'nope',
        { id: 'r2' },
      ],
    };
    expect(folderRoots(a)).toEqual([
      { id: 'r1', name: 'Reports' },
      { id: 'r2', name: 'r2' },
    ]);
  });

  it('returns [] for a legacy config that has no folderRoots', () => {
    const a = accountWith([]);
    a.config = {
      paths: ['/Users/me/Documents'],
      roots: [{ rootFolderId: 'x' }],
    };
    expect(folderRoots(a)).toEqual([]);
  });

  it('classifies absolute filesystem paths, never opaque provider ids', () => {
    expect(isLocalPathRoot('/Users/me/Documents')).toBe(true);
    expect(isLocalPathRoot('C:\\Users\\me\\Documents')).toBe(true);
    expect(isLocalPathRoot('0B246AxIx6hdAeTBrQ0xLbVhuRTQ')).toBe(false);
    expect(isLocalPathRoot('root')).toBe(false);
  });
});

describe('TrackedFolders rows', () => {
  it('renders one row per canonical root, name plus opaque id', () => {
    render(
      <TrackedFolders
        account={accountWith([
          { id: 'root', name: 'My Drive' },
          { id: '0B246', name: 'Reports' },
        ])}
      />,
    );
    expect(screen.getByText('My Drive')).toBeInTheDocument();
    expect(screen.getByText('Reports')).toBeInTheDocument();
    expect(screen.getByText('0B246')).toBeInTheDocument();
  });

  it('never asks for a file count on a cloud root', () => {
    render(
      <TrackedFolders
        account={accountWith([
          { id: 'root', name: 'My Drive' },
          { id: '0B246', name: 'Reports' },
        ])}
      />,
    );
    expect(invokeMock()).not.toHaveBeenCalledWith(
      'sources:count-files',
      expect.anything(),
    );
    expect(screen.queryByText('counting…')).not.toBeInTheDocument();
  });

  it('counts a local absolute-path root over sources:count-files', async () => {
    render(
      <TrackedFolders
        account={accountWith(
          [
            { id: '/Users/me/Documents', name: 'Documents' },
            { id: '/Users/me/Code', name: 'Code' },
          ],
          'live',
          'local-folder',
        )}
      />,
    );
    expect(invokeMock()).toHaveBeenCalledWith('sources:count-files', {
      path: '/Users/me/Documents',
    });
    expect(await screen.findAllByText('12 files')).toHaveLength(2);
  });

  it('disables the last root’s Remove with the shipped tooltip', () => {
    render(
      <TrackedFolders
        account={accountWith([{ id: 'root', name: 'My Drive' }])}
      />,
    );
    const remove = screen.getByRole('button', { name: /Remove/ });
    expect(remove).toBeDisabled();
    // R3, verbatim. Replaces the shipped `Remove the source instead`.
    expect(remove).toHaveAttribute(
      'title',
      'Remove this source to stop tracking its last folder.',
    );
  });

  it('renders a needsReauth account read-only, with the reconnect hint', () => {
    render(
      <TrackedFolders
        account={accountWith(
          [
            { id: 'root', name: 'My Drive' },
            { id: '0B246', name: 'Reports' },
          ],
          'needsReauth',
        )}
      />,
    );
    expect(
      screen.queryByRole('button', { name: /Manage folders/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText('Reconnect this source to change its tracked folders.'),
    ).toBeInTheDocument();
    for (const b of screen.getAllByRole('button', { name: /Remove/ }))
      expect(b).toBeDisabled();
  });

  it('renders the empty state so Manage folders stays reachable', () => {
    render(<TrackedFolders account={accountWith([])} />);
    expect(screen.getByText('No folders selected yet.')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Manage folders/ }),
    ).toBeEnabled();
  });
});

// The wire shape of Task 7's `folder-picker` event: `selected` is
// contracts.FolderNode[] (id/name/hasChildren), `purpose` is required.
const PICKER_EVENT = {
  flowId: 'f1',
  kind: 'folder-picker' as const,
  requestId: 'p1',
  multiSelect: true,
  modes: [{ key: 'drive', label: 'My Drive' }],
  selected: [
    { id: 'root', name: 'My Drive', hasChildren: true },
    { id: '0B246', name: 'Reports', hasChildren: true },
  ],
  purpose: 'manage' as const,
  expand: ['root', '0B111'],
};

const TWO_ROOTS = [
  { id: 'root', name: 'My Drive' },
  { id: '0B246', name: 'Reports' },
];

describe('TrackedFolders manage flow', () => {
  it('Manage folders… starts the account-scoped flow, never accounts:update-config', async () => {
    render(<TrackedFolders account={accountWith(TWO_ROOTS)} />);
    fireEvent.click(screen.getByRole('button', { name: /Manage folders/ }));
    await act(async () => {});

    expect(invokeMock()).toHaveBeenCalledWith('accounts:start-manage-folders', {
      accountId: 'a1',
    });
    expect(invokeMock()).not.toHaveBeenCalledWith(
      'accounts:update-config',
      expect.anything(),
    );
  });

  it('opens the modal preselected with the current roots and purpose manage', async () => {
    render(<TrackedFolders account={accountWith(TWO_ROOTS)} />);
    fireEvent.click(screen.getByRole('button', { name: /Manage folders/ }));
    await act(async () => {});
    act(() => pushHandler!(PICKER_EVENT));

    expect(screen.getByTestId('picker')).toHaveAttribute(
      'data-purpose',
      'manage',
    );
    expect(screen.getByTestId('picker-selected')).toHaveTextContent(
      'root,0B246',
    );
  });

  // C-50 regression: this component rebuilds `picker` field-by-field out of
  // the wire event, so a new picker-spec field is dropped unless it is named
  // here too. `expand` was added to the contract, the IPC wire, the
  // out-of-process proxy and the adapter -- and still never reached the
  // modal, because this object literal is a FOURTH hand-written allowlist.
  it('forwards the wire expand ids to the modal so the tree opens revealed', async () => {
    render(<TrackedFolders account={accountWith(TWO_ROOTS)} />);
    fireEvent.click(screen.getByRole('button', { name: /Manage folders/ }));
    await act(async () => {});
    act(() => pushHandler!(PICKER_EVENT));

    expect(screen.getByTestId('picker-expand')).toHaveTextContent('root,0B111');
  });

  it('Save in the modal confirms the ids through the picker adapter', async () => {
    render(<TrackedFolders account={accountWith(TWO_ROOTS)} />);
    fireEvent.click(screen.getByRole('button', { name: /Manage folders/ }));
    await act(async () => {});
    act(() => pushHandler!(PICKER_EVENT));
    fireEvent.click(screen.getByRole('button', { name: 'picker-save' }));
    await act(async () => {});

    expect(mockConfirm).toHaveBeenCalledWith(['r1']);
  });

  it('a scope-saved event reports the counts and re-enables the card', async () => {
    render(<TrackedFolders account={accountWith(TWO_ROOTS)} />);
    fireEvent.click(screen.getByRole('button', { name: /Manage folders/ }));
    await act(async () => {});
    act(() =>
      pushHandler!({
        flowId: 'f1',
        kind: 'scope-saved',
        accountId: 'a1',
        added: 1,
        retained: 1,
        removed: 2,
      }),
    );

    expect(
      screen.getByText('Folders updated — 1 added, 2 removed.'),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Manage folders/ }),
    ).toBeEnabled();
  });

  it('a flow error renders inline instead of failing silently', async () => {
    render(<TrackedFolders account={accountWith(TWO_ROOTS)} />);
    fireEvent.click(screen.getByRole('button', { name: /Manage folders/ }));
    await act(async () => {});
    act(() => pushHandler!({ flowId: 'f1', kind: 'error', msg: 'drive: 403' }));

    expect(
      screen.getByText('Couldn’t update tracked folders: drive: 403'),
    ).toBeInTheDocument();
    // Decision 9: the flow is settled main-side, so the card re-arms rather
    // than holding a dead modal open.
    expect(
      screen.getByRole('button', { name: /Manage folders/ }),
    ).toBeEnabled();
  });
});

describe('TrackedFolders per-root Remove shortcut', () => {
  async function removeReports(): Promise<void> {
    render(<TrackedFolders account={accountWith(TWO_ROOTS)} />);
    fireEvent.click(
      screen.getAllByRole('button', { name: /Remove/ })[1], // the Reports row
    );
    fireEvent.click(
      within(
        screen.getByRole('dialog', { name: 'Stop tracking folder' }),
      ).getByRole('button', { name: /Remove/ }),
    );
    await act(async () => {});
    act(() => pushHandler!(PICKER_EVENT));
    await act(async () => {});
  }

  it('confirms the complete remaining set without ever opening the modal', async () => {
    await removeReports();
    expect(invokeMock()).toHaveBeenCalledWith('accounts:start-manage-folders', {
      accountId: 'a1',
    });
    expect(mockConfirm).toHaveBeenCalledWith(['root']);
    expect(screen.queryByTestId('picker')).not.toBeInTheDocument();
  });

  it('cancels instead of confirming when the source no longer reports that root', async () => {
    render(<TrackedFolders account={accountWith(TWO_ROOTS)} />);
    fireEvent.click(screen.getAllByRole('button', { name: /Remove/ })[1]);
    fireEvent.click(
      within(
        screen.getByRole('dialog', { name: 'Stop tracking folder' }),
      ).getByRole('button', { name: /Remove/ }),
    );
    await act(async () => {});
    act(() =>
      pushHandler!({
        ...PICKER_EVENT,
        selected: [{ id: 'root', name: 'My Drive', hasChildren: true }],
      }),
    );
    await act(async () => {});

    expect(mockConfirm).not.toHaveBeenCalled();
    expect(mockCancel).toHaveBeenCalled();
    expect(invokeMock()).toHaveBeenCalledWith('accounts:cancel-flow', {
      flowId: 'f1',
    });
  });
});

describe('TrackedFolders cancel', () => {
  it('Cancel in the modal cancels the flow and renders no error', async () => {
    render(<TrackedFolders account={accountWith(TWO_ROOTS)} />);
    fireEvent.click(screen.getByRole('button', { name: /Manage folders/ }));
    await act(async () => {});
    act(() => pushHandler!(PICKER_EVENT));
    fireEvent.click(screen.getByRole('button', { name: 'picker-close' }));
    await act(async () => {});

    expect(mockCancel).toHaveBeenCalled();
    expect(invokeMock()).toHaveBeenCalledWith('accounts:cancel-flow', {
      flowId: 'f1',
    });

    // connect-broker.ts:166-168 answers a cancelled flow with an error push —
    // it must never surface as a save failure.
    act(() =>
      pushHandler!({
        flowId: 'f1',
        kind: 'error',
        msg: 'connect flow cancelled',
      }),
    );
    expect(
      screen.queryByText(/Couldn’t update tracked folders/),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Manage folders/ }),
    ).toBeEnabled();
  });

  it('unmounting mid-flow cancels it main-side', async () => {
    const { unmount } = render(
      <TrackedFolders account={accountWith(TWO_ROOTS)} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Manage folders/ }));
    await act(async () => {});
    unmount();

    expect(invokeMock()).toHaveBeenCalledWith('accounts:cancel-flow', {
      flowId: 'f1',
    });
  });

  it('unmounting after Save lets the in-flight save land', async () => {
    const { unmount } = render(
      <TrackedFolders account={accountWith(TWO_ROOTS)} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Manage folders/ }));
    await act(async () => {});
    act(() => pushHandler!(PICKER_EVENT));
    fireEvent.click(screen.getByRole('button', { name: 'picker-save' }));
    await act(async () => {});
    unmount();

    expect(invokeMock()).not.toHaveBeenCalledWith(
      'accounts:cancel-flow',
      expect.anything(),
    );
  });
});
