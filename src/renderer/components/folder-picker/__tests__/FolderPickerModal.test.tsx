import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { FolderPickerModal } from '../FolderPickerModal';
import type { FolderPickerDataSource } from '../FolderPickerModal';

const invokeMock = jest.fn();

beforeEach(() => {
  invokeMock.mockReset();
  (window as unknown as { kiagent: { invoke: jest.Mock } }).kiagent = {
    invoke: invokeMock,
  };
});

function makeDataSource(
  overrides: Partial<FolderPickerDataSource> = {},
): FolderPickerDataSource {
  return {
    modes: [
      { key: 'm1', label: 'My Drive' },
      { key: 'm2', label: 'Shared' },
    ],
    listRoots: jest.fn(async (modeKey: string) =>
      modeKey === 'm1'
        ? [{ id: 'r1', path: '/r1', name: 'Root One', hasChildren: true }]
        : [{ id: 's1', path: '/s1', name: 'Shared One', hasChildren: false }],
    ),
    listChildren: jest.fn(async (path: string) => [
      { id: 'c1', path: `${path}/c1`, name: 'Child One', hasChildren: false },
    ]),
    countFiles: jest.fn(async (path: string) =>
      path === '/r1' ? { count: 5, capped: false } : null,
    ),
    ...overrides,
  };
}

describe('FolderPickerModal with a dataSource', () => {
  it('renders the dataSource modes as tabs and lists its roots with counts', async () => {
    const ds = makeDataSource();
    render(
      <FolderPickerModal
        dataSource={ds}
        onConfirm={jest.fn()}
        onClose={jest.fn()}
      />,
    );

    expect(
      screen.getByRole('button', { name: 'My Drive' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Shared' })).toBeInTheDocument();
    // The built-in local-FS tabs must NOT render.
    expect(
      screen.queryByRole('button', { name: 'Quick links' }),
    ).not.toBeInTheDocument();

    expect(await screen.findByText('Root One')).toBeInTheDocument();
    expect(await screen.findByText('5 files')).toBeInTheDocument();
    expect(ds.listRoots).toHaveBeenCalledWith('m1');
    expect(invokeMock).not.toHaveBeenCalled(); // never touches the local-FS IPC
  });

  it('expanding a node lists its children through the dataSource', async () => {
    const ds = makeDataSource();
    render(
      <FolderPickerModal
        dataSource={ds}
        onConfirm={jest.fn()}
        onClose={jest.fn()}
      />,
    );
    await screen.findByText('Root One');

    fireEvent.click(screen.getByRole('button', { name: 'expand Root One' }));
    expect(await screen.findByText('Child One')).toBeInTheDocument();
    expect(ds.listChildren).toHaveBeenCalledWith('/r1');
  });

  it('switching modes loads that mode’s roots', async () => {
    const ds = makeDataSource();
    render(
      <FolderPickerModal
        dataSource={ds}
        onConfirm={jest.fn()}
        onClose={jest.fn()}
      />,
    );
    await screen.findByText('Root One');

    fireEvent.click(screen.getByRole('button', { name: 'Shared' }));
    expect(await screen.findByText('Shared One')).toBeInTheDocument();
    expect(ds.listRoots).toHaveBeenCalledWith('m2');
    expect(screen.queryByText('Root One')).not.toBeInTheDocument();
  });

  it('multi-select: confirming fires onConfirm with the selected paths, then onClose', async () => {
    const ds = makeDataSource();
    const onConfirm = jest.fn();
    const onClose = jest.fn();
    render(
      <FolderPickerModal
        multiSelect
        dataSource={ds}
        onConfirm={onConfirm}
        onClose={onClose}
      />,
    );

    fireEvent.click(await screen.findByText('Root One'));
    fireEvent.click(screen.getByRole('button', { name: 'Add 1 folder' }));
    expect(onConfirm).toHaveBeenCalledWith(['r1']);
    expect(onClose).toHaveBeenCalled();
  });

  it('multi-select: one folder listed under two modes selects once, not twice', async () => {
    const ds = makeDataSource({
      listRoots: jest.fn(async (modeKey: string) =>
        modeKey === 'm1'
          ? [
              {
                id: 'dup',
                path: '/my-dup',
                name: 'Dup (My Drive)',
                hasChildren: false,
              },
            ]
          : [
              {
                id: 'dup',
                path: '/shared-dup',
                name: 'Dup (Shared)',
                hasChildren: false,
              },
            ],
      ),
    });
    render(
      <FolderPickerModal
        multiSelect
        dataSource={ds}
        onConfirm={jest.fn()}
        onClose={jest.fn()}
      />,
    );

    fireEvent.click(await screen.findByText('Dup (My Drive)'));
    // waitFor because countFiles('/my-dup') resolves null asynchronously and
    // the footer reads "1 folder selected · counting…" until it settles —
    // the same reason the "source without counts" test (`:133-135`) waits.
    await waitFor(() =>
      expect(screen.getByText('1 folder selected')).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Shared' }));
    fireEvent.click(await screen.findByText('Dup (Shared)'));
    // Before id-keying this read "2 folders selected": two synthetic paths,
    // neither a prefix of the other, so coveringRoots could not collapse
    // them, and switchMode (`:310-315`) never cleared `checked`. Same id ⇒
    // the second click toggles the SAME folder off.
    expect(screen.getByText('No folders selected')).toBeInTheDocument();
  });

  it('a source without counts never leaves the footer stuck on "counting…"', async () => {
    const ds = makeDataSource({
      countFiles: jest.fn(async () => null), // hasCount:false → always null
    });
    render(
      <FolderPickerModal
        multiSelect
        dataSource={ds}
        onConfirm={jest.fn()}
        onClose={jest.fn()}
      />,
    );

    fireEvent.click(await screen.findByText('Root One'));
    // The count settles as unavailable — the footer shows the plain
    // selection line, with neither an estimate nor a perpetual counting….
    await waitFor(() =>
      expect(screen.getByText('1 folder selected')).toBeInTheDocument(),
    );
    expect(screen.queryByText(/counting…/)).not.toBeInTheDocument();
  });

  it('single-select footer shows the node NAME, not the synthetic path', async () => {
    const ds = makeDataSource();
    render(
      <FolderPickerModal
        dataSource={ds}
        onConfirm={jest.fn()}
        onClose={jest.fn()}
      />,
    );

    fireEvent.click(await screen.findByText('Root One'));
    // Two "Root One" texts now: the row and the footer summary.
    expect(screen.getAllByText('Root One').length).toBeGreaterThan(1);
    expect(screen.queryByText('/r1')).not.toBeInTheDocument();
  });

  it('a rejected listChildren renders an inline retry, not an empty expansion', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    let calls = 0;
    const ds = makeDataSource({
      listChildren: jest.fn(async (path: string) => {
        calls += 1;
        if (calls === 1) throw new Error('drive said no');
        return [
          {
            id: 'c1',
            path: `${path}/c1`,
            name: 'Child One',
            hasChildren: false,
          },
        ];
      }),
    });
    render(
      <FolderPickerModal
        dataSource={ds}
        onConfirm={jest.fn()}
        onClose={jest.fn()}
      />,
    );
    await screen.findByText('Root One');

    fireEvent.click(screen.getByRole('button', { name: 'expand Root One' }));
    expect(
      await screen.findByText('Couldn’t list this folder.'),
    ).toBeInTheDocument();
    // The failure did NOT masquerade as a loaded-but-empty expansion: the
    // chevron still offers to expand. THIS IS THE FLIPPED ASSERTION — the
    // replaced test required the `collapse Root One` control at `:173-175`.
    expect(
      screen.getByRole('button', { name: 'expand Root One' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'collapse Root One' }),
    ).not.toBeInTheDocument();
    expect(warn).toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Child One')).toBeInTheDocument();
    expect(
      screen.queryByText('Couldn’t list this folder.'),
    ).not.toBeInTheDocument();
    warn.mockRestore();
  });

  it('a successful re-expand after a failed listing clears the error row', async () => {
    // DECISIONS C-42: the chevron survives a failed listing (asserted above),
    // so it is a live affordance — re-expanding, rather than pressing Retry,
    // must not leave "Couldn't list this folder." pinned under the now-loaded
    // node. The error row is DERIVED from useLazyTree's `loaded`, not from a
    // second copy of load state that can drift.
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    let calls = 0;
    const ds = makeDataSource({
      listChildren: jest.fn(async (path: string) => {
        calls += 1;
        if (calls === 1) throw new Error('drive said no');
        return [
          {
            id: 'c1',
            path: `${path}/c1`,
            name: 'Child One',
            hasChildren: false,
          },
        ];
      }),
    });
    render(
      <FolderPickerModal
        dataSource={ds}
        onConfirm={jest.fn()}
        onClose={jest.fn()}
      />,
    );
    await screen.findByText('Root One');

    fireEvent.click(screen.getByRole('button', { name: 'expand Root One' }));
    expect(
      await screen.findByText('Couldn’t list this folder.'),
    ).toBeInTheDocument();

    // Re-expand via the chevron, NOT via Retry.
    fireEvent.click(screen.getByRole('button', { name: 'expand Root One' }));
    expect(await screen.findByText('Child One')).toBeInTheDocument();
    expect(
      screen.queryByText('Couldn’t list this folder.'),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'collapse Root One' }),
    ).toBeInTheDocument();
    warn.mockRestore();
  });

  it('a rejected listRoots renders an inline retry, not a silently empty tree', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    let calls = 0;
    const ds = makeDataSource({
      listRoots: jest.fn(async () => {
        calls += 1;
        if (calls === 1) throw new Error('drive said no');
        return [{ id: 'r1', path: '/r1', name: 'Root One', hasChildren: true }];
      }),
    });
    render(
      <FolderPickerModal
        dataSource={ds}
        onConfirm={jest.fn()}
        onClose={jest.fn()}
      />,
    );

    expect(
      await screen.findByText('Couldn’t list folders.'),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Root One')).toBeInTheDocument();
    expect(
      screen.queryByText('Couldn’t list folders.'),
    ).not.toBeInTheDocument();
    warn.mockRestore();
  });

  it('a rejected countFiles leaves the row uncounted', async () => {
    const ds = makeDataSource({
      countFiles: jest.fn(async () => {
        throw new Error('no counting today');
      }),
    });
    render(
      <FolderPickerModal
        dataSource={ds}
        onConfirm={jest.fn()}
        onClose={jest.fn()}
      />,
    );
    await screen.findByText('Root One');
    // The in-flight "counting…" label resolves away and no count lands.
    await waitFor(() =>
      expect(screen.queryByText('counting…')).not.toBeInTheDocument(),
    );
    expect(screen.getByText('Root One')).toBeInTheDocument();
    expect(screen.queryByText(/files/)).not.toBeInTheDocument();
  });

  it('`selected` renders checked, REMOVABLE chips, and a never-listed root still saves', async () => {
    const onConfirm = jest.fn();
    const ds = makeDataSource();
    render(
      <FolderPickerModal
        multiSelect
        selected={[
          { id: 'keep', path: '', name: 'Kept Folder', hasChildren: false },
          { id: 'drop', path: '', name: 'Dropped Folder', hasChildren: false },
        ]}
        dataSource={ds}
        onConfirm={onConfirm}
        onClose={jest.fn()}
      />,
    );

    // Chips are present before any listing resolves — unlike `existingPaths`,
    // which renders an inert `tracked` pill and no chip at all.
    expect(screen.getByText('Kept Folder')).toBeInTheDocument();
    expect(screen.queryByText('tracked')).not.toBeInTheDocument();
    await screen.findByText('Root One');

    fireEvent.click(
      screen.getByRole('button', {
        name: 'remove Dropped Folder from selection',
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Add 1 folder' }));
    // Neither root's row was ever listed. Path-keying dropped both here —
    // the A8 data-loss path.
    expect(onConfirm).toHaveBeenCalledWith(['keep']);
  });

  it('`selected` wins over an overlapping `existingPaths` root, which still governs other rows', async () => {
    const onConfirm = jest.fn();
    const ds = makeDataSource();
    render(
      <FolderPickerModal
        multiSelect
        existingPaths={['/r1']}
        selected={[
          { id: 'r1', path: '', name: 'Root One', hasChildren: true },
          { id: 'keep', path: '', name: 'Kept Folder', hasChildren: false },
        ]}
        dataSource={ds}
        onConfirm={onConfirm}
        onClose={jest.fn()}
      />,
    );
    // Wait on the ROW's own control, not on its text: 'Root One' is already
    // on screen as a chip, so findByText would match twice and throw.
    await screen.findByRole('button', { name: 'expand Root One' });

    // DECISIONS A-6: the row matches BOTH props and `selected` wins — it is
    // this account's own current scope. The id escape holds from the first
    // render, before any listing gives the entry a comparable path.
    expect(screen.queryByText('tracked')).not.toBeInTheDocument();
    // …and `existingPaths` is untouched for every OTHER row: Child One sits
    // under /r1 and is not itself selected, so it stays inert.
    fireEvent.click(screen.getByRole('button', { name: 'expand Root One' }));
    expect(await screen.findByText('tracked')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Add 2 folders' }));
    expect(onConfirm).toHaveBeenCalledWith(['r1', 'keep']);
  });

  it('a `selected` entry’s `path` is never trusted as a tree location', async () => {
    const onConfirm = jest.fn();
    const ds = makeDataSource();
    render(
      <FolderPickerModal
        multiSelect
        // A hostile path: it collides with the path the listing gives a
        // DIFFERENT folder. Seeding it would make Root One look already
        // covered by an ancestor, and its click a silent no-op.
        selected={[
          { id: 'keep', path: '/r1', name: 'Kept Folder', hasChildren: false },
        ]}
        dataSource={ds}
        onConfirm={onConfirm}
        onClose={jest.fn()}
      />,
    );

    fireEvent.click(await screen.findByText('Root One'));
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Add 2 folders' }),
      ).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Add 2 folders' }));
    expect(onConfirm).toHaveBeenCalledWith(['keep', 'r1']);
  });

  it('the `selected` seed is mount-once: a re-render keeps the user’s edits, a remount reseeds', async () => {
    const ds = makeDataSource();
    const kept = {
      id: 'keep',
      path: '',
      name: 'Kept Folder',
      hasChildren: false,
    };
    const other = {
      id: 'other',
      path: '',
      name: 'Other Folder',
      hasChildren: false,
    };
    const { rerender } = render(
      <FolderPickerModal
        key="req-1"
        multiSelect
        selected={[kept]}
        dataSource={ds}
        onConfirm={jest.fn()}
        onClose={jest.fn()}
      />,
    );
    await screen.findByText('Root One');

    fireEvent.click(
      screen.getByRole('button', { name: 'remove Kept Folder from selection' }),
    );
    expect(screen.getByText('No folders selected')).toBeInTheDocument();

    // Same key ⇒ same mount: a parent re-render must not resurrect what the
    // user just removed (there is deliberately no prop-sync effect).
    rerender(
      <FolderPickerModal
        key="req-1"
        multiSelect
        selected={[kept]}
        dataSource={ds}
        onConfirm={jest.fn()}
        onClose={jest.fn()}
      />,
    );
    expect(screen.getByText('No folders selected')).toBeInTheDocument();

    // A new key REMOUNTS and reseeds. This is the ONLY re-seed path, and it
    // is exactly how a validation retry reopens the picker: the source
    // re-issues pickFolders, the event carries a new requestId, and
    // `key={picker.requestId}` (AddSourcePanel.tsx:410) remounts.
    rerender(
      <FolderPickerModal
        key="req-2"
        multiSelect
        selected={[other]}
        dataSource={ds}
        onConfirm={jest.fn()}
        onClose={jest.fn()}
      />,
    );
    expect(await screen.findByText('Other Folder')).toBeInTheDocument();
  });

  it('purpose "manage" uses the manage title, Save folders, and the last-root line', async () => {
    const ds = makeDataSource();
    render(
      <FolderPickerModal
        multiSelect
        purpose="manage"
        dataSource={ds}
        onConfirm={jest.fn()}
        onClose={jest.fn()}
      />,
    );
    await screen.findByText('Root One');

    expect(
      screen.getByRole('heading', { name: 'Manage tracked folders' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('dialog', { name: 'Manage tracked folders' }),
    ).toBeInTheDocument();
    // DECISIONS R3, verbatim.
    expect(
      screen.getByText(
        'Keep at least one folder — remove this source to stop tracking it entirely.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save folders' })).toBeDisabled();

    fireEvent.click(screen.getByText('Root One'));
    expect(screen.getByRole('button', { name: 'Save folders' })).toBeEnabled();
  });

  it('purpose "connect" keeps the add-flow copy', async () => {
    const ds = makeDataSource();
    render(
      <FolderPickerModal
        multiSelect
        purpose="connect"
        dataSource={ds}
        onConfirm={jest.fn()}
        onClose={jest.fn()}
      />,
    );
    await screen.findByText('Root One');

    expect(
      screen.getByRole('heading', { name: 'Choose folders' }),
    ).toBeInTheDocument();
    expect(screen.getByText('No folders selected')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Root One'));
    expect(
      screen.getByRole('button', { name: 'Add 1 folder' }),
    ).toBeInTheDocument();
  });

  it('a rejected Save keeps the picker open with the selection intact and the message inline', async () => {
    const onConfirm = jest.fn();
    const onClose = jest.fn();
    const ds = makeDataSource();
    // No `key` anywhere in this test: it is ONE mount from start to finish,
    // which is the whole point — the widget must survive a rejected Save.
    const { rerender } = render(
      <FolderPickerModal
        multiSelect
        keepOpenOnConfirm
        dataSource={ds}
        onConfirm={onConfirm}
        onClose={onClose}
      />,
    );

    fireEvent.click(await screen.findByText('Root One'));
    fireEvent.click(screen.getByRole('button', { name: 'Add 1 folder' }));
    expect(onConfirm).toHaveBeenCalledWith(['r1']);
    // A-8: the modal must NOT tear itself down — that is what lets Task 9's
    // owner keep the flow alive instead of setFlow(null).
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    // …while the owner commits.
    rerender(
      <FolderPickerModal
        multiSelect
        keepOpenOnConfirm
        saving
        dataSource={ds}
        onConfirm={onConfirm}
        onClose={onClose}
      />,
    );
    expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled();

    // …and when the owner rejects it: message inline, selection untouched,
    // the widget left retryable. The LIVE retry is a REMOUNT with a new
    // requestId — pickFolders is one-shot (connect-broker.ts:228-232) — which
    // the mount-once seed test above pins.
    rerender(
      <FolderPickerModal
        multiSelect
        keepOpenOnConfirm
        error="That folder no longer exists."
        dataSource={ds}
        onConfirm={onConfirm}
        onClose={onClose}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent(
      'That folder no longer exists.',
    );
    expect(
      screen.getByRole('button', { name: 'remove Root One from selection' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add 1 folder' })).toBeEnabled();
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('FolderPickerModal without a dataSource (historical local-FS behavior)', () => {
  it('renders the quick/drives tabs and reads the tree over the local-FS IPC', async () => {
    invokeMock.mockImplementation(async (channel: string) => {
      if (channel === 'sources:list-folders') {
        return {
          entries: [{ path: '/Users/t', name: 'Home', hasChildren: false }],
        };
      }
      if (channel === 'sources:count-files') return { count: 2, capped: false };
      throw new Error(`unexpected channel ${channel}`);
    });
    render(<FolderPickerModal onConfirm={jest.fn()} onClose={jest.fn()} />);

    expect(
      screen.getByRole('button', { name: 'Quick links' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Browse from drive root…' }),
    ).toBeInTheDocument();

    expect(await screen.findByText('Home')).toBeInTheDocument();
    expect(await screen.findByText('2 files')).toBeInTheDocument();
    expect(invokeMock).toHaveBeenCalledWith('sources:list-folders', {
      special: 'quick',
    });
    expect(invokeMock).toHaveBeenCalledWith('sources:count-files', {
      path: '/Users/t',
    });
  });
});
