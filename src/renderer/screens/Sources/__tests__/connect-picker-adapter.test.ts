import type { FolderNode } from '@shared/contracts';
import type { RendererApi } from '@shared/ipc';
import { coveringRoots, isUnder } from '@shared/folder-paths';

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

  it('listRoots synthesizes "/"-prefixed ancestry paths and carries the node id', async () => {
    const { calls, invoke } = makeInvoke();
    const adapter = createConnectPickerAdapter(PICKER, invoke);

    await expect(adapter.dataSource.listRoots('drive')).resolves.toEqual([
      { id: 'idA', path: '/idA', name: 'Alpha', hasChildren: true },
      { id: 'idB', path: '/idB', name: 'Beta', hasChildren: false },
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
      { id: 'idC', path: '/idA/idC', name: 'Child', hasChildren: false },
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

  it('confirm maps the picked ids back to their FolderNodes', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const { calls, invoke } = makeInvoke();
    const adapter = createConnectPickerAdapter(PICKER, invoke);
    await adapter.dataSource.listRoots('drive');
    await adapter.dataSource.listChildren('/idA');

    await adapter.confirm(['idC', 'idB', 'never-listed']);
    expect(calls[2]).toEqual({
      channel: 'accounts:picker-confirm',
      payload: { requestId: 'req-1', nodes: [CHILD, ROOT_B] },
    });
    expect(warn).toHaveBeenCalledWith(
      'folder picker: unknown confirmed node id',
      'never-listed',
    );
    warn.mockRestore();
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
    await adapter.confirm([report.id]);
    expect(calls[1]).toEqual({
      channel: 'accounts:picker-confirm',
      payload: { requestId: 'req-1', nodes: [report] },
    });
    // …and the round trip returns the EXACT original node objects,
    // backslash id intact (byId is the decoder — nothing re-parses paths).
    await adapter.confirm([report.id, reportYear.id]);
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

    await adapter.confirm([child.id]);
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
      { id: 'ok', path: '/ok', name: 'Fine', hasChildren: false },
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
      { id: 'dup', path: '/dup', name: 'First', hasChildren: false },
    ]);
    expect(warn).toHaveBeenCalledWith(
      'folder picker: skipping duplicate sibling id',
      'dup',
    );

    await adapter.confirm(['dup']);
    const { nodes } = (calls[1] as { payload: { nodes: FolderNode[] } })
      .payload;
    expect(nodes[0]).toBe(first);
    warn.mockRestore();
  });
});

describe('createConnectPickerAdapter — preselected roots (manage folders)', () => {
  it('confirms preselected roots whose rows were never listed', async () => {
    const { calls, invoke } = makeTreeInvoke({ roots: [] });
    // Built as a variable rather than an inline literal on purpose: an inline
    // `{ ...PICKER, selected: [...] }` argument trips TS2353 excess-property
    // checking against today's parameter type, so the suite would fail to
    // COMPILE on the argument instead of on the assertion below. (Verified
    // with the repo's own tsc 5.8.2: the variable form is clean, the literal
    // form errors.)
    const picker = { ...PICKER, selected: [ROOT_A, ROOT_B] };
    const adapter = createConnectPickerAdapter(picker, invoke);

    // The Manage modal opened with both roots checked; the user changed
    // nothing and saved without expanding either row.
    await adapter.confirm([ROOT_A.id, ROOT_B.id]);

    expect(calls[0]).toEqual({
      channel: 'accounts:picker-confirm',
      payload: { requestId: 'req-1', nodes: [ROOT_A, ROOT_B] },
    });
  });

  it('exposes the preselected set as modal rows with root-level paths', async () => {
    const { invoke } = makeTreeInvoke({ roots: [] });
    const picker = { ...PICKER, selected: [ROOT_A, ROOT_B] };
    const adapter = createConnectPickerAdapter(picker, invoke);

    // C-7's conversion point: the wire carries FolderNode[], the modal's
    // `selected` prop takes Entry[], and this is where that happens — the
    // only place in the plan where it happens.
    expect(adapter.selected).toEqual([
      { id: 'idA', path: '/idA', name: 'Alpha', hasChildren: true },
      { id: 'idB', path: '/idB', name: 'Beta', hasChildren: false },
    ]);
  });

  it('a preselected row can be expanded before anything is listed', async () => {
    const { calls, invoke } = makeTreeInvoke({
      roots: [],
      children: { idA: [CHILD] },
    });
    const picker = { ...PICKER, selected: [ROOT_A] };
    const adapter = createConnectPickerAdapter(picker, invoke);

    // The seeded rows must be real tree rows, not chips: byPath is seeded
    // alongside byId or the first expand throws `unknown picker path`.
    await expect(
      adapter.dataSource.listChildren(adapter.selected[0].path),
    ).resolves.toEqual([
      { id: 'idC', path: '/idA/idC', name: 'Child', hasChildren: false },
    ]);
    expect(calls[0]).toEqual({
      channel: 'accounts:picker-children',
      payload: { requestId: 'req-1', id: 'idA' },
    });
  });

  it('a later listing overwrites the seeded node for the same id', async () => {
    const renamed: FolderNode = {
      id: 'idA',
      name: 'Alpha (renamed)',
      hasChildren: true,
    };
    const { calls, invoke } = makeTreeInvoke({ roots: [renamed] });
    const picker = { ...PICKER, selected: [ROOT_A] };
    const adapter = createConnectPickerAdapter(picker, invoke);

    await adapter.dataSource.listRoots('drive');
    await adapter.confirm(['idA']);

    // The freshly listed node carries the CURRENT name/hasChildren; the
    // seeded copy is a stale snapshot of the saved config.
    const { nodes } = (calls[1] as { payload: { nodes: FolderNode[] } })
      .payload;
    expect(nodes[0]).toBe(renamed);
  });

  it('warns instead of silently dropping an id never seeded or listed', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const { calls, invoke } = makeTreeInvoke({ roots: [] });
    const picker = { ...PICKER, selected: [ROOT_A] };
    const adapter = createConnectPickerAdapter(picker, invoke);

    await adapter.confirm(['idA', 'ghost']);

    expect(warn).toHaveBeenCalledWith(
      'folder picker: unknown confirmed node id',
      'ghost',
    );
    const { nodes } = (calls[0] as { payload: { nodes: FolderNode[] } })
      .payload;
    expect(nodes).toEqual([ROOT_A]);
    warn.mockRestore();
  });
});

describe('createConnectPickerAdapter — absolute-path ids (local folder)', () => {
  const HOME: FolderNode = { id: '/Users/ed', name: 'ed', hasChildren: true };
  const DOCS: FolderNode = {
    id: '/Users/ed/docs',
    name: 'docs',
    hasChildren: false,
  };

  it('sibling absolute-path ids never falsely nest', async () => {
    const { calls, invoke } = makeTreeInvoke({ roots: [HOME, DOCS] });
    const adapter = createConnectPickerAdapter(PICKER, invoke);

    const entries = await adapter.dataSource.listRoots('drive');
    const [pathHome, pathDocs] = entries.map((e) => e.path);
    expect(pathHome).toBe('/%2FUsers%2Fed');
    expect(pathDocs).toBe('/%2FUsers%2Fed%2Fdocs');
    // Two sibling ROWS, not an ancestor pair: only the tree's own expansion
    // establishes ancestry, never the id text. Unencoded, '//Users/ed/docs'
    // reads as a descendant of '//Users/ed'.
    expect(isUnder(pathDocs, pathHome)).toBe(false);
    expect(isUnder(pathHome, pathDocs)).toBe(false);

    await adapter.confirm([DOCS.id]);
    const { nodes } = (calls[1] as { payload: { nodes: FolderNode[] } })
      .payload;
    expect(nodes).toEqual([DOCS]);
  });

  it('preselected absolute-path roots stay an antichain', async () => {
    const { invoke } = makeTreeInvoke({ roots: [] });
    const picker = { ...PICKER, selected: [HOME, DOCS] };
    const adapter = createConnectPickerAdapter(picker, invoke);

    // This is the A9 defect in one line: `coveringRoots` is what the modal
    // runs over the checked set, and unencoded ids make it silently drop a
    // saved root the user never touched.
    const paths = adapter.selected.map((e) => e.path);
    expect(coveringRoots(paths)).toEqual(paths);
  });

  it('the segment encoding stays injective for ids `a%2Fb` and `a/b`', async () => {
    const literal: FolderNode = {
      id: 'a%2Fb',
      name: 'Literal',
      hasChildren: false,
    };
    const slash: FolderNode = { id: 'a/b', name: 'Slash', hasChildren: false };
    const { invoke } = makeTreeInvoke({ roots: [literal, slash] });
    const adapter = createConnectPickerAdapter(PICKER, invoke);

    const entries = await adapter.dataSource.listRoots('drive');
    expect(entries).toHaveLength(2);
    // '%' is escaped first, so the literal cannot masquerade as the encoded '/'.
    expect(entries[0].path).toBe('/a%252Fb');
    expect(entries[1].path).toBe('/a%2Fb');
    expect(entries.every((e) => !e.path.slice(1).includes('/'))).toBe(true);
  });
});
