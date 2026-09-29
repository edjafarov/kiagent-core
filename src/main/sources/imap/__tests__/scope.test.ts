import { resolveMailboxes } from '../folders';
import {
  allMailFolder,
  defaultRoots,
  pickerModel,
  resolveScopedMailboxes,
  rootsOf,
  specialKind,
} from '../scope';
import type { ImapFolderInfo } from '../types';

const f = (
  path: string,
  extra: Partial<ImapFolderInfo> = {},
): ImapFolderInfo => ({ path, flags: [], ...extra });
const roots = (...ids: string[]) => ids.map((id) => ({ id, name: id }));
const paths = (r: { path: string }[]) => r.map((m) => m.path);

// Folder server, '/' delimiter, with specials and a Noselect container.
const slash = (): ImapFolderInfo[] => [
  f('INBOX', { delimiter: '/' }),
  f('Sent', { delimiter: '/', specialUse: '\\Sent' }),
  f('Archive', { delimiter: '/', specialUse: '\\Archive' }),
  f('Drafts', { delimiter: '/', specialUse: '\\Drafts' }),
  f('Trash', { delimiter: '/', specialUse: '\\Trash' }),
  f('Spam', { delimiter: '/' }),
  f('Projects', { delimiter: '/', flags: ['\\noselect'] }),
  f('Projects/Acme', { delimiter: '/', parentPath: 'Projects' }),
  f('Projects/Beta', { delimiter: '/', parentPath: 'Projects' }),
  f('Projects/Beta/Old', { delimiter: '/', parentPath: 'Projects/Beta' }),
  f('Receipts', { delimiter: '/' }),
  f('Ghost', { delimiter: '/', flags: ['\\nonexistent'] }),
];

// Dovecot/Courier style: '.' delimiter, INBOX namespace.
const dotted = (): ImapFolderInfo[] => [
  f('INBOX', { delimiter: '.' }),
  f('INBOX.Sent', { delimiter: '.', parentPath: 'INBOX' }),
  f('INBOX.Work', { delimiter: '.', parentPath: 'INBOX' }),
  f('INBOX.Work.X', { delimiter: '.', parentPath: 'INBOX.Work' }),
  f('INBOX.Trash', { delimiter: '.', parentPath: 'INBOX' }),
  f('Other', { delimiter: '.' }),
];

const gmail = (): ImapFolderInfo[] => [
  f('INBOX', { delimiter: '/' }),
  f('[Gmail]', { delimiter: '/', flags: ['\\noselect'] }),
  f('[Gmail]/All Mail', {
    delimiter: '/',
    parentPath: '[Gmail]',
    specialUse: '\\All',
  }),
  f('[Gmail]/Sent Mail', {
    delimiter: '/',
    parentPath: '[Gmail]',
    specialUse: '\\Sent',
  }),
  f('[Gmail]/Trash', {
    delimiter: '/',
    parentPath: '[Gmail]',
    specialUse: '\\Trash',
  }),
  f('[Gmail]/Spam', {
    delimiter: '/',
    parentPath: '[Gmail]',
    specialUse: '\\Junk',
  }),
  f('[Gmail]/Drafts', {
    delimiter: '/',
    parentPath: '[Gmail]',
    specialUse: '\\Drafts',
  }),
  f('Label1', { delimiter: '/' }),
  f('Label1/Sub', { delimiter: '/', parentPath: 'Label1' }),
];

describe('rootsOf', () => {
  it('is null when undeclared and the array when declared', () => {
    expect(rootsOf(null)).toBeNull();
    expect(rootsOf(undefined)).toBeNull();
    expect(rootsOf({})).toBeNull();
    expect(rootsOf({ folderRoots: 'x' })).toBeNull();
    expect(rootsOf({ folderRoots: [] })).toEqual([]);
    expect(rootsOf({ folderRoots: roots('A') })).toEqual(roots('A'));
  });
});

describe('specialKind', () => {
  it('detects by SPECIAL-USE case-insensitively', () => {
    expect(specialKind(f('x', { specialUse: '\\TRASH' }))).toBe('trash');
    expect(specialKind(f('x', { specialUse: '\\junk' }))).toBe('junk');
    expect(specialKind(f('x', { specialUse: '\\Drafts' }))).toBe('drafts');
    expect(specialKind(f('x', { specialUse: '\\Sent' }))).toBeNull();
  });
  it('detects by leaf name, using the delimiter', () => {
    expect(specialKind(f('Deleted Items'))).toBe('trash');
    expect(specialKind(f('INBOX.Bin', { delimiter: '.' }))).toBe('trash');
    expect(specialKind(f('Mail/Junk E-mail', { delimiter: '/' }))).toBe('junk');
    expect(specialKind(f('Bulk Mail'))).toBe('junk');
    expect(specialKind(f('INBOX.Draft', { delimiter: '.' }))).toBe('drafts');
    expect(
      specialKind(f('Projects/Trash Talk', { delimiter: '/' })),
    ).toBeNull();
    expect(specialKind(f('INBOX'))).toBeNull();
  });
});

describe('legacy (undeclared roots)', () => {
  const fixtures: Record<string, ImapFolderInfo[]> = {
    gmail: gmail(),
    dovecot: [f('INBOX'), f('Sent', { specialUse: '\\Sent' }), f('Trash')],
    nameOnlySent: [f('INBOX'), f('Sent Items'), f('Junk')],
    allMailByName: [f('INBOX'), f('All Mail'), f('Sent Mail')],
    inboxOnly: [f('inbox')],
    empty: [],
  };
  for (const [name, folders] of Object.entries(fixtures)) {
    it(`matches resolveMailboxes exactly: ${name}`, () => {
      expect(resolveScopedMailboxes(folders, null)).toEqual(
        resolveMailboxes(folders).map((m) => ({
          path: m.path,
          rootId: m.path,
        })),
      );
    });
  }
});

describe('subtree cover', () => {
  it("covers descendants using the mailbox's '/' delimiter", () => {
    const r = resolveScopedMailboxes(slash(), roots('Projects/Beta'));
    expect(r).toEqual([
      { path: 'Projects/Beta', rootId: 'Projects/Beta' },
      { path: 'Projects/Beta/Old', rootId: 'Projects/Beta' },
    ]);
  });
  it("covers descendants using the '.' delimiter", () => {
    const r = resolveScopedMailboxes(dotted(), roots('INBOX.Work'));
    expect(paths(r)).toEqual(['INBOX.Work', 'INBOX.Work.X']);
  });
  it('does not cover a sibling that merely shares a prefix', () => {
    const folders = [
      f('Proj', { delimiter: '/' }),
      f('Projects', { delimiter: '/' }),
    ];
    expect(paths(resolveScopedMailboxes(folders, roots('Proj')))).toEqual([
      'Proj',
    ]);
  });
  it('matches INBOX case-insensitively, for the root and the mailbox', () => {
    const folders = [
      f('inbox', { delimiter: '/' }),
      f('Inbox.Sub', { delimiter: '.' }),
      f('Other', { delimiter: '.' }),
    ];
    expect(paths(resolveScopedMailboxes(folders, roots('INBOX')))).toEqual([
      'inbox',
      'Inbox.Sub',
    ]);
    expect(paths(resolveScopedMailboxes(folders, roots('inbox')))).toEqual([
      'inbox',
      'Inbox.Sub',
    ]);
  });
  it('an INBOX root covers the whole INBOX namespace minus specials', () => {
    const r = resolveScopedMailboxes(dotted(), roots('INBOX'));
    expect(paths(r)).toEqual([
      'INBOX',
      'INBOX.Sent',
      'INBOX.Work',
      'INBOX.Work.X',
    ]);
    expect(r.every((m) => m.rootId === 'INBOX')).toBe(true);
  });
  it('orders by folders order, dedupes, and attributes the covering root', () => {
    const r = resolveScopedMailboxes(
      slash(),
      roots('Receipts', 'Projects/Beta/Old', 'Projects/Beta', 'INBOX'),
    );
    expect(r).toEqual([
      { path: 'INBOX', rootId: 'INBOX' },
      { path: 'Projects/Beta', rootId: 'Projects/Beta' },
      { path: 'Projects/Beta/Old', rootId: 'Projects/Beta/Old' },
      { path: 'Receipts', rootId: 'Receipts' },
    ]);
  });
});

describe('special folders', () => {
  it('are never covered by a parent root (by special-use and by name)', () => {
    const r = resolveScopedMailboxes(dotted(), roots('INBOX'));
    expect(paths(r)).not.toContain('INBOX.Trash');
    const s = resolveScopedMailboxes(slash(), roots('INBOX', 'Receipts'));
    expect(paths(s)).toEqual(['INBOX', 'Receipts']);
  });
  it('sync only when their exact path is a root; drafts never', () => {
    const r = resolveScopedMailboxes(slash(), roots('Trash', 'Spam', 'Drafts'));
    expect(r).toEqual([
      { path: 'Trash', rootId: 'Trash' },
      { path: 'Spam', rootId: 'Spam' },
    ]);
  });
  it('never appear in the picker tree, only as opt-in rows', () => {
    const m = pickerModel(slash());
    const all = [...m.roots, ...m.roots.flatMap((n) => m.children(n.id))];
    expect(all.map((n) => n.id)).not.toContain('Drafts');
    expect(m.offers('Drafts')).toBe(false);
    expect(m.offers('Trash')).toBe(true);
    expect(m.offers('Spam')).toBe(true);
    expect(m.roots.filter((n) => n.name === 'Trash')).toEqual([
      { id: 'Trash', name: 'Trash', hasChildren: false },
    ]);
    expect(m.roots.filter((n) => n.name === 'Junk')).toEqual([
      { id: 'Spam', name: 'Junk', hasChildren: false },
    ]);
  });
  it('descendants of a special folder are neither shown nor covered', () => {
    const folders = [
      f('INBOX', { delimiter: '.' }),
      f('INBOX.Trash', { delimiter: '.', parentPath: 'INBOX' }),
      f('INBOX.Trash.Old', { delimiter: '.', parentPath: 'INBOX.Trash' }),
    ];
    expect(paths(resolveScopedMailboxes(folders, roots('INBOX')))).toEqual([
      'INBOX',
    ]);
    expect(pickerModel(folders).offers('INBOX.Trash.Old')).toBe(false);
  });
  it('prefers a SPECIAL-USE trash over a name match for the opt-in row', () => {
    const folders = [
      f('Trash', { delimiter: '/' }),
      f('Deleted', { delimiter: '/', specialUse: '\\Trash' }),
    ];
    expect(pickerModel(folders).roots.find((n) => n.name === 'Trash')?.id).toBe(
      'Deleted',
    );
  });
});

describe('All-Mail server', () => {
  it('finds the \\All mailbox', () => {
    expect(allMailFolder(gmail())?.path).toBe('[Gmail]/All Mail');
    expect(allMailFolder(slash())).toBeUndefined();
  });
  it('picker roots are exactly All Mail + Trash/Junk opt-ins, no labels', () => {
    const m = pickerModel(gmail());
    expect(m.roots).toEqual([
      { id: '[Gmail]/All Mail', name: 'All Mail', hasChildren: false },
      { id: '[Gmail]/Trash', name: 'Trash', hasChildren: false },
      { id: '[Gmail]/Spam', name: 'Junk', hasChildren: false },
    ]);
    expect(m.children('[Gmail]/All Mail')).toEqual([]);
    expect(m.offers('Label1')).toBe(false);
    expect(m.offers('INBOX')).toBe(false);
    expect(m.offers('[Gmail]/Drafts')).toBe(false);
  });
  it('resolve ignores label roots, keeping All Mail and exact opt-ins', () => {
    const r = resolveScopedMailboxes(
      gmail(),
      roots('Label1', 'INBOX', '[Gmail]/All Mail', '[Gmail]/Spam'),
    );
    expect(r).toEqual([
      { path: '[Gmail]/All Mail', rootId: '[Gmail]/All Mail' },
      { path: '[Gmail]/Spam', rootId: '[Gmail]/Spam' },
    ]);
    expect(paths(resolveScopedMailboxes(gmail(), roots('Label1')))).toEqual([]);
  });
  it('defaultRoots is All Mail only (no Sent)', () => {
    expect(defaultRoots(gmail())).toEqual(roots('[Gmail]/All Mail'));
  });
});

describe('Noselect and NonExistent', () => {
  it('a Noselect root covers its children and is never resolved itself', () => {
    const r = resolveScopedMailboxes(slash(), roots('Projects'));
    expect(paths(r)).toEqual([
      'Projects/Acme',
      'Projects/Beta',
      'Projects/Beta/Old',
    ]);
    expect(r.every((m) => m.rootId === 'Projects')).toBe(true);
  });
  it('a Noselect exact-path root resolves to nothing by itself', () => {
    expect(
      resolveScopedMailboxes(
        [f('Projects', { flags: ['\\noselect'] })],
        roots('Projects'),
      ),
    ).toEqual([]);
  });
  it('a Noselect parent is shown only with shown children', () => {
    const m = pickerModel(slash());
    expect(m.roots.find((n) => n.id === 'Projects')).toEqual({
      id: 'Projects',
      name: 'Projects',
      hasChildren: true,
    });
    const lonely = pickerModel([
      f('INBOX'),
      f('Empty', { flags: ['\\noselect'] }),
    ]);
    expect(lonely.offers('Empty')).toBe(false);
  });
  it('NonExistent never appears anywhere', () => {
    const m = pickerModel(slash());
    expect(m.offers('Ghost')).toBe(false);
    expect(paths(resolveScopedMailboxes(slash(), roots('Ghost')))).toEqual([]);
    expect(
      paths(resolveScopedMailboxes(slash(), roots('INBOX', 'Receipts'))),
    ).not.toContain('Ghost');
  });
});

describe('roots that no longer exist', () => {
  it('are excluded without throwing', () => {
    expect(resolveScopedMailboxes(slash(), roots('Gone', 'Receipts'))).toEqual([
      { path: 'Receipts', rootId: 'Receipts' },
    ]);
  });
  it('yields [] when every root is missing (callers throw)', () => {
    expect(resolveScopedMailboxes(slash(), roots('Gone', 'Nope'))).toEqual([]);
    expect(resolveScopedMailboxes(slash(), [])).toEqual([]);
  });
});

describe('defaultRoots on a folder server', () => {
  it('is INBOX + Sent + Archive, deduped', () => {
    expect(defaultRoots(slash())).toEqual(roots('INBOX', 'Sent', 'Archive'));
  });
  it('omits Archive when absent', () => {
    expect(defaultRoots(dotted())).toEqual(roots('INBOX', 'INBOX.Sent'));
  });
  it("dedupes when Archive is also today's pick", () => {
    const folders = [f('INBOX'), f('Archive', { specialUse: '\\All' })];
    expect(defaultRoots(folders)).toEqual(roots('Archive'));
  });
});

describe('pickerModel on a folder server', () => {
  it('builds the tree from parentPath, leaf names, specials excluded', () => {
    const m = pickerModel(slash());
    expect(m.roots.map((n) => n.id)).toEqual([
      'INBOX',
      'Sent',
      'Archive',
      'Projects',
      'Receipts',
      'Trash',
      'Spam',
    ]);
    expect(m.children('Projects')).toEqual([
      { id: 'Projects/Acme', name: 'Acme', hasChildren: false },
      { id: 'Projects/Beta', name: 'Beta', hasChildren: true },
    ]);
    expect(m.children('Projects/Beta')).toEqual([
      { id: 'Projects/Beta/Old', name: 'Old', hasChildren: false },
    ]);
    expect(m.children('Trash')).toEqual([]);
    expect(m.children('nope')).toEqual([]);
  });
  it('treats a folder whose parent is not listed as top level', () => {
    const m = pickerModel([f('A/B', { delimiter: '/', parentPath: 'A' })]);
    expect(m.roots.map((n) => n.id)).toEqual(['A/B']);
  });
  it('offers any node at any depth, and opt-in rows', () => {
    const m = pickerModel(slash());
    expect(m.offers('Projects/Beta/Old')).toBe(true);
    expect(m.offers('Projects')).toBe(true);
    expect(m.offers('Unknown')).toBe(false);
  });
  it('expand returns ancestors only, deduped, never the ids themselves', () => {
    const m = pickerModel(slash());
    expect(m.expand(['Projects/Beta/Old', 'Projects/Acme'])).toEqual([
      'Projects/Beta',
      'Projects',
    ]);
    expect(m.expand(['Projects/Beta', 'Projects/Beta/Old'])).toEqual([
      'Projects',
    ]);
    expect(m.expand(['INBOX', 'Trash', 'Unknown'])).toEqual([]);
  });
});
