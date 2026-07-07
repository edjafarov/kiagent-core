import type { FolderNode } from '@shared/contracts';
import type { RendererApi } from '@shared/ipc';
import { isUnder } from '@shared/folder-paths';

import { createConnectPickerAdapter } from '../connect-picker-adapter';

const ROOT_A: FolderNode = { id: 'idA', name: 'Alpha', hasChildren: true };
const ROOT_B: FolderNode = { id: 'idB', name: 'Beta', hasChildren: false };
const CHILD: FolderNode = { id: 'idC', name: 'Child', hasChildren: false };

function makeInvoke() {
  const calls: Array<{ channel: string; payload: unknown }> = [];
  const fn = jest.fn(async (channel: string, payload: unknown) => {
    calls.push({ channel, payload });
    switch (channel) {
      case 'accounts:picker-roots':
        return [ROOT_A, ROOT_B];
      case 'accounts:picker-children':
        return [CHILD];
      case 'accounts:picker-count':
        return { count: 3, capped: false };
      default:
        return undefined;
    }
  });
  return { calls, invoke: fn as unknown as RendererApi['invoke'] };
}

const PICKER = {
  requestId: 'req-1',
  modes: [{ key: 'drive', label: 'My Drive' }],
};

describe('createConnectPickerAdapter', () => {
  it('exposes the event modes on the dataSource', () => {
    const { invoke } = makeInvoke();
    const adapter = createConnectPickerAdapter(PICKER, invoke);
    expect(adapter.dataSource.modes).toEqual(PICKER.modes);
  });

  it('listRoots synthesizes "/"-prefixed paths from opaque node ids', async () => {
    const { calls, invoke } = makeInvoke();
    const adapter = createConnectPickerAdapter(PICKER, invoke);

    await expect(adapter.dataSource.listRoots('drive')).resolves.toEqual([
      { path: '/idA', name: 'Alpha', hasChildren: true },
      { path: '/idB', name: 'Beta', hasChildren: false },
    ]);
    expect(calls).toEqual([
      {
        channel: 'accounts:picker-roots',
        payload: { requestId: 'req-1', mode: 'drive' },
      },
    ]);
  });

  it('listChildren asks by node id and extends the parent path', async () => {
    const { calls, invoke } = makeInvoke();
    const adapter = createConnectPickerAdapter(PICKER, invoke);
    await adapter.dataSource.listRoots('drive');

    await expect(adapter.dataSource.listChildren('/idA')).resolves.toEqual([
      { path: '/idA/idC', name: 'Child', hasChildren: false },
    ]);
    expect(calls[1]).toEqual({
      channel: 'accounts:picker-children',
      payload: { requestId: 'req-1', id: 'idA' },
    });
  });

  it('listChildren rejects an unknown path (the modal renders it empty)', async () => {
    const { invoke } = makeInvoke();
    const adapter = createConnectPickerAdapter(PICKER, invoke);
    await expect(
      adapter.dataSource.listChildren('/never-listed'),
    ).rejects.toThrow('unknown picker path');
  });

  it('countFiles asks by node id, and resolves null for an unknown path without invoking', async () => {
    const { calls, invoke } = makeInvoke();
    const adapter = createConnectPickerAdapter(PICKER, invoke);
    await adapter.dataSource.listRoots('drive');

    await expect(adapter.dataSource.countFiles('/idA')).resolves.toEqual({
      count: 3,
      capped: false,
    });
    expect(calls[1]).toEqual({
      channel: 'accounts:picker-count',
      payload: { requestId: 'req-1', id: 'idA' },
    });

    await expect(adapter.dataSource.countFiles('/unknown')).resolves.toBeNull();
    expect(calls).toHaveLength(2); // no extra invoke for the unknown path
  });

  it('confirm maps the picked paths back to their FolderNodes', async () => {
    const { calls, invoke } = makeInvoke();
    const adapter = createConnectPickerAdapter(PICKER, invoke);
    await adapter.dataSource.listRoots('drive');
    await adapter.dataSource.listChildren('/idA');

    await adapter.confirm(['/idA/idC', '/idB', '/never-listed']);
    expect(calls[2]).toEqual({
      channel: 'accounts:picker-confirm',
      payload: { requestId: 'req-1', nodes: [CHILD, ROOT_B] },
    });
  });

  it('cancel sends picker-cancel for the requestId', async () => {
    const { calls, invoke } = makeInvoke();
    const adapter = createConnectPickerAdapter(PICKER, invoke);
    await adapter.cancel();
    expect(calls).toEqual([
      { channel: 'accounts:picker-cancel', payload: { requestId: 'req-1' } },
    ]);
  });
});

/** invoke fake whose roots/children are supplied per test — for the
 *  exotic-but-contract-legal id cases (I1/M6). */
function makeTreeInvoke(tree: {
  roots: FolderNode[];
  children?: Record<string, FolderNode[]>;
}) {
  const calls: Array<{ channel: string; payload: unknown }> = [];
  const fn = jest.fn(async (channel: string, payload: unknown) => {
    calls.push({ channel, payload });
    if (channel === 'accounts:picker-roots') return tree.roots;
    if (channel === 'accounts:picker-children') {
      const { id } = payload as { id: string };
      return tree.children?.[id] ?? [];
    }
    return undefined;
  });
  return { calls, invoke: fn as unknown as RendererApi['invoke'] };
}

describe('createConnectPickerAdapter — exotic but contract-legal ids', () => {
  it('sibling ids `report` and `report\\2024` never falsely cover each other', async () => {
    const report: FolderNode = {
      id: 'report',
      name: 'Report',
      hasChildren: false,
    };
    const reportYear: FolderNode = {
      id: 'report\\2024',
      name: 'Report 2024',
      hasChildren: false,
    };
    const { calls, invoke } = makeTreeInvoke({ roots: [report, reportYear] });
    const adapter = createConnectPickerAdapter(PICKER, invoke);

    const entries = await adapter.dataSource.listRoots('drive');
    expect(entries.map((e) => e.name)).toEqual(['Report', 'Report 2024']);
    const [pathA, pathB] = entries.map((e) => e.path);
    // The '\' is encoded away, so the picker's separator-aware prefix logic
    // cannot treat one sibling as the other's descendant (in either
    // direction) — both stay independently selectable.
    expect(isUnder(pathB, pathA)).toBe(false);
    expect(isUnder(pathA, pathB)).toBe(false);

    // Each confirms independently…
    await adapter.confirm([pathA]);
    expect(calls[1]).toEqual({
      channel: 'accounts:picker-confirm',
      payload: { requestId: 'req-1', nodes: [report] },
    });
    // …and the round trip returns the EXACT original node objects,
    // backslash id intact (byPath is the decoder — nothing re-parses paths).
    await adapter.confirm([pathA, pathB]);
    const { nodes } = (calls[2] as { payload: { nodes: FolderNode[] } })
      .payload;
    expect(nodes[0]).toBe(report);
    expect(nodes[1]).toBe(reportYear);
    expect(nodes[1].id).toBe('report\\2024');
  });

  it('the segment encoding is injective: ids `a%5Cb` and `a\\b` get distinct paths', async () => {
    const literal: FolderNode = {
      id: 'a%5Cb',
      name: 'Literal',
      hasChildren: false,
    };
    const backslash: FolderNode = {
      id: 'a\\b',
      name: 'Backslash',
      hasChildren: false,
    };
    const { invoke } = makeTreeInvoke({ roots: [literal, backslash] });
    const adapter = createConnectPickerAdapter(PICKER, invoke);

    const entries = await adapter.dataSource.listRoots('drive');
    expect(entries).toHaveLength(2);
    expect(entries[0].path).not.toBe(entries[1].path);
    expect(entries.every((e) => !e.path.includes('\\'))).toBe(true);
  });

  it('children under a backslash-id parent are asked for by the ORIGINAL id', async () => {
    const parent: FolderNode = {
      id: 'report\\2024',
      name: 'Report 2024',
      hasChildren: true,
    };
    const child: FolderNode = { id: 'q1', name: 'Q1', hasChildren: false };
    const { calls, invoke } = makeTreeInvoke({
      roots: [parent],
      children: { 'report\\2024': [child] },
    });
    const adapter = createConnectPickerAdapter(PICKER, invoke);

    const [root] = await adapter.dataSource.listRoots('drive');
    const kids = await adapter.dataSource.listChildren(root.path);
    expect(calls[1]).toEqual({
      channel: 'accounts:picker-children',
      payload: { requestId: 'req-1', id: 'report\\2024' },
    });
    expect(kids).toHaveLength(1);
    expect(kids[0].path.startsWith(`${root.path}/`)).toBe(true);

    await adapter.confirm([kids[0].path]);
    const { nodes } = (calls[2] as { payload: { nodes: FolderNode[] } })
      .payload;
    expect(nodes[0]).toBe(child);
  });

  it('skips empty-string ids with a warning (an empty segment would cover every sibling)', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const empty: FolderNode = { id: '', name: 'Broken', hasChildren: false };
    const ok: FolderNode = { id: 'ok', name: 'Fine', hasChildren: false };
    const { invoke } = makeTreeInvoke({ roots: [empty, ok] });
    const adapter = createConnectPickerAdapter(PICKER, invoke);

    const entries = await adapter.dataSource.listRoots('drive');
    expect(entries).toEqual([
      { path: '/ok', name: 'Fine', hasChildren: false },
    ]);
    expect(warn).toHaveBeenCalledWith(
      'folder picker: skipping node with empty id',
      'Broken',
    );
    warn.mockRestore();
  });

  it('skips duplicate sibling ids with a warning; the first wins', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const first: FolderNode = { id: 'dup', name: 'First', hasChildren: false };
    const second: FolderNode = {
      id: 'dup',
      name: 'Second',
      hasChildren: false,
    };
    const { calls, invoke } = makeTreeInvoke({ roots: [first, second] });
    const adapter = createConnectPickerAdapter(PICKER, invoke);

    const entries = await adapter.dataSource.listRoots('drive');
    expect(entries).toEqual([
      { path: '/dup', name: 'First', hasChildren: false },
    ]);
    expect(warn).toHaveBeenCalledWith(
      'folder picker: skipping duplicate sibling id',
      'dup',
    );

    await adapter.confirm(['/dup']);
    const { nodes } = (calls[1] as { payload: { nodes: FolderNode[] } })
      .payload;
    expect(nodes[0]).toBe(first);
    warn.mockRestore();
  });
});
