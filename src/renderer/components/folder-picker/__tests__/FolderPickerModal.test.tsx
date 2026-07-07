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
        ? [{ path: '/r1', name: 'Root One', hasChildren: true }]
        : [{ path: '/s1', name: 'Shared One', hasChildren: false }],
    ),
    listChildren: jest.fn(async (path: string) => [
      { path: `${path}/c1`, name: 'Child One', hasChildren: false },
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
    expect(onConfirm).toHaveBeenCalledWith(['/r1']);
    expect(onClose).toHaveBeenCalled();
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

  it('a rejected listChildren renders the node as an empty expansion (warned, not thrown)', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const ds = makeDataSource({
      listChildren: jest.fn(async () => {
        throw new Error('drive said no');
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
    // Expansion settles as loaded-with-no-children — collapse control flips.
    expect(
      await screen.findByRole('button', { name: 'collapse Root One' }),
    ).toBeInTheDocument();
    expect(screen.queryByText('Child One')).not.toBeInTheDocument();
    expect(warn).toHaveBeenCalled();
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
