import type {
  Account,
  AuthChannel,
  FolderNode,
  FolderPickerSpec,
  FolderSelectionChannel,
  Session,
} from '@shared/contracts';

import * as api from '../gmail-api';
import { bucketTask, type GmailCursor } from '../cursor';
import { connect, descriptor, manageFolders } from '../gmail-source';

jest.mock('../gmail-api', () => ({
  ...jest.requireActual('../gmail-api'),
  fetchProfileWithToken: jest.fn(),
}));

const MAIL = { id: 'mail', name: 'All mail' };
const TRASH = { id: 'TRASH', name: 'Trash' };

function session(
  folderRoots: Array<{ id: string; name: string }> | undefined,
  cursor: unknown,
): Session {
  const account: Account = {
    id: 'acc-1' as Account['id'],
    source: 'gmail',
    identifier: 'owner@example.com',
    config: folderRoots ? { folderRoots } : {},
    status: 'connecting',
    cursor,
    createdAt: new Date().toISOString(),
  };
  return {
    account,
    signal: new AbortController().signal,
    credentials: async () => ({ accessToken: 't' }),
    log: () => {},
  };
}

/** A channel that records the spec and "ticks" the given ids. */
function picking(ids: string[]) {
  const seen: { spec?: FolderPickerSpec } = {};
  const channel: FolderSelectionChannel = {
    status: () => {},
    pickFolders: async (spec) => {
      seen.spec = spec;
      const all = await spec.roots(spec.modes[0].key);
      return all.filter((n) => ids.includes(n.id));
    },
  };
  return { channel, seen };
}

const node = (n: FolderNode) => n.id;

describe('gmail folder scope (spec §4)', () => {
  it('declares folderScope', () => {
    expect(descriptor.folderScope).toBe(true);
  });

  it('connect writes the default [mail] selection', async () => {
    (api.fetchProfileWithToken as jest.Mock).mockResolvedValue({
      emailAddress: 'owner@example.com',
    });
    const auth = {
      status: () => {},
      oauth: async () => ({ accessToken: 't' }),
    } as unknown as AuthChannel;
    expect(await connect(auth)).toEqual({
      identifier: 'owner@example.com',
      config: { folderRoots: [MAIL] },
    });
  });

  it('the picker offers the three buckets, leaf nodes, current selection ticked', async () => {
    const { channel, seen } = picking(['mail']);
    await manageFolders(session(undefined, null), channel);
    const spec = seen.spec!;
    expect(spec.purpose).toBe('manage');
    expect(spec.multiSelect).toBe(true);
    const roots = await spec.roots(spec.modes[0].key);
    expect(roots.map(node)).toEqual(['mail', 'TRASH', 'SPAM']);
    expect(roots.every((n) => !n.hasChildren)).toBe(true);
    expect(await spec.children('mail')).toEqual([]);
    // A legacy {} config reads as [mail].
    expect(spec.selected!.map(node)).toEqual(['mail']);
  });

  it('widening appends a bucket task, keeps unfinished ones and the watermark', async () => {
    const cur: GmailCursor = {
      v: 2,
      historyId: 'h',
      tasks: [{ q: null, pageToken: 'p' }],
    };
    const { channel } = picking(['mail', 'TRASH']);
    const up = await manageFolders(session([MAIL], cur), channel);
    expect(up.config.folderRoots).toEqual([MAIL, TRASH]);
    expect(up.archiveScopeRootIds).toEqual([]);
    expect(up.cursor).toEqual({
      v: 2,
      historyId: 'h',
      tasks: [{ q: null, pageToken: 'p' }, bucketTask('TRASH')],
    });
  });

  it('a legacy v1 cursor is migrated before the task is appended', async () => {
    const { channel } = picking(['mail', 'SPAM']);
    const up = await manageFolders(
      session(undefined, { mode: 'delta', historyId: 'h' }),
      channel,
    );
    expect(up.cursor).toEqual({
      v: 2,
      historyId: 'h',
      tasks: [bucketTask('SPAM')],
    });
  });

  it('narrowing archives the removed bucket and drops its queued task', async () => {
    const cur: GmailCursor = {
      v: 2,
      historyId: 'h',
      tasks: [{ ...bucketTask('TRASH'), pageToken: 'p' }],
    };
    const { channel } = picking(['mail']);
    const up = await manageFolders(session([MAIL, TRASH], cur), channel);
    expect(up.config.folderRoots).toEqual([MAIL]);
    expect(up.archiveScopeRootIds).toEqual(['TRASH']);
    expect(up.cursor).toEqual({ v: 2, historyId: 'h', tasks: [] });
  });

  it('an unchanged selection returns the cursor untouched', async () => {
    const cur: GmailCursor = { v: 2, historyId: 'h', tasks: [] };
    const { channel } = picking(['mail', 'TRASH']);
    const up = await manageFolders(session([MAIL, TRASH], cur), channel);
    expect(up.cursor).toEqual(cur);
    expect(up.archiveScopeRootIds).toEqual([]);
  });

  it('a null cursor stays null — the first pull queues the new selection', async () => {
    const { channel } = picking(['mail', 'TRASH']);
    const up = await manageFolders(session([MAIL], null), channel);
    expect(up.cursor).toBeNull();
  });

  it('rejects a selection without All mail', async () => {
    const { channel } = picking(['TRASH']);
    await expect(manageFolders(session([MAIL], null), channel)).rejects.toThrow(
      'gmail: All mail must stay selected',
    );
  });
});
