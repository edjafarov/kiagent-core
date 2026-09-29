import type { FolderNode, FolderRootSelection } from '@shared/contracts';
import { resolveMailboxes } from './folders';
import type { ImapFolderInfo } from './types';

/**
 * Folder scope for the IMAP source — the ONE place that decides which
 * mailboxes are synced and what the folder picker shows. Pure, no I/O:
 * pull, reconcile, connect and manageFolders all go through
 * resolveScopedMailboxes so they can never disagree.
 */

export type SpecialKind = 'trash' | 'junk' | 'drafts';

export interface ScopedMailbox {
  path: string;
  /** Id of the root that covers this mailbox (stamped as scopeRootId). */
  rootId: string;
}

export interface PickerModel {
  /** Top-level nodes: the tree top plus the Trash/Junk opt-in rows. */
  roots: FolderNode[];
  /** Direct child folders of a node (never specials). */
  children(id: string): FolderNode[];
  /** ANCESTOR ids of the selected ids (never the ids themselves), deduped. */
  expand(selectedIds: string[]): string[];
  /** Is this id a node the picker can show? */
  offers(id: string): boolean;
}

const SPECIAL_USE: Record<string, SpecialKind> = {
  '\\trash': 'trash',
  '\\junk': 'junk',
  '\\drafts': 'drafts',
};
const SPECIAL_NAMES: Array<[SpecialKind, RegExp]> = [
  ['trash', /^(trash|deleted items|deleted messages|bin)$/i],
  ['junk', /^(junk|junk e-mail|junk email|spam|bulk mail)$/i],
  ['drafts', /^drafts?$/i],
];

/** Declared roots, or null when the account never declared any (legacy). */
export function rootsOf(
  config: Record<string, unknown> | null | undefined,
): FolderRootSelection[] | null {
  const roots = config?.folderRoots;
  return Array.isArray(roots) ? (roots as FolderRootSelection[]) : null;
}

/** Trash / Junk / Drafts, by SPECIAL-USE first, else by the leaf name. */
export function specialKind(f: ImapFolderInfo): SpecialKind | null {
  const bySu = f.specialUse ? SPECIAL_USE[f.specialUse.toLowerCase()] : null;
  if (bySu) return bySu;
  const name = leaf(f);
  return SPECIAL_NAMES.find(([, rx]) => rx.test(name))?.[0] ?? null;
}

/** The \All special-use mailbox (Gmail-style), if the server has one. */
export function allMailFolder(
  folders: ImapFolderInfo[],
): ImapFolderInfo | undefined {
  return folders.find((f) => f.specialUse?.toLowerCase() === '\\all');
}

/**
 * The mailboxes to sync for a set of roots. `roots === null` is the legacy
 * (undeclared) path and is exactly resolveMailboxes. A root that matches
 * nothing yields nothing; callers throw on an empty result.
 */
export function resolveScopedMailboxes(
  folders: ImapFolderInfo[],
  roots: FolderRootSelection[] | null,
): ScopedMailbox[] {
  if (roots === null) {
    return resolveMailboxes(folders).map((m) => ({
      path: m.path,
      rootId: m.path,
    }));
  }

  const all = allMailFolder(folders);
  const specialPaths = specialPathsOf(folders);
  const out: ScopedMailbox[] = [];
  const seen = new Set<string>();
  for (const f of folders) {
    if (unsyncable(f) || seen.has(f.path)) continue;
    const kind = specialKind(f);
    let rootId: string | undefined;
    if (kind === 'trash' || kind === 'junk') {
      // Opt-in only: never covered by a parent, synced on an exact root.
      if (isRoot(roots, f)) rootId = f.path;
    } else if (kind === 'drafts') {
      continue;
    } else if (all) {
      // All-Mail server: only All Mail is offered; label roots select nothing.
      if (f === all && isRoot(roots, f)) rootId = f.path;
    } else if (!underSpecial(f, specialPaths)) {
      rootId = roots.find((r) => covers(r.id, f))?.id;
    }
    if (rootId === undefined) continue;
    seen.add(f.path);
    out.push({ path: f.path, rootId });
  }
  return out;
}

/** Roots preselected on connect and for the legacy picker. */
export function defaultRoots(folders: ImapFolderInfo[]): FolderRootSelection[] {
  const all = allMailFolder(folders);
  const paths = all ? [all.path] : resolveMailboxes(folders).map((m) => m.path);
  if (!all) {
    const archive = folders.find(
      (f) => f.specialUse?.toLowerCase() === '\\archive' && !unsyncable(f),
    );
    if (archive) paths.push(archive.path);
  }
  return [...new Set(paths)].map((p) => ({ id: p, name: p }));
}

/** What the folder picker shows for this server (see PickerModel). */
export function pickerModel(folders: ImapFolderInfo[]): PickerModel {
  const all = allMailFolder(folders);
  const specialPaths = specialPathsOf(folders);

  const optIns: FolderNode[] = [];
  for (const [kind, name] of [
    ['trash', 'Trash'],
    ['junk', 'Junk'],
  ] as const) {
    const cands = folders.filter(
      (f) =>
        specialKind(f) === kind &&
        !unsyncable(f) &&
        !underSpecial(f, specialPaths),
    );
    const pick =
      cands.find(
        (f) => SPECIAL_USE[f.specialUse?.toLowerCase() ?? ''] === kind,
      ) ?? cands[0];
    if (pick) optIns.push({ id: pick.path, name, hasChildren: false });
  }

  if (all) {
    const roots: FolderNode[] = [
      { id: all.path, name: 'All Mail', hasChildren: false },
      ...optIns,
    ];
    const ids = new Set(roots.map((n) => n.id));
    return {
      roots,
      children: () => [],
      expand: () => [],
      offers: (id) => ids.has(id),
    };
  }

  // Tree: selectable, non-special mailboxes, plus \Noselect containers that
  // lead to at least one of them.
  const cand = new Map<string, ImapFolderInfo>();
  for (const f of folders) {
    if (isNonExistent(f) || specialKind(f) || underSpecial(f, specialPaths)) {
      continue;
    }
    cand.set(f.path, f);
  }
  const shown = new Set<string>();
  for (const f of cand.values()) {
    if (unsyncable(f)) continue;
    let cur: ImapFolderInfo | undefined = f;
    while (cur && !shown.has(cur.path)) {
      shown.add(cur.path);
      cur = cur.parentPath ? cand.get(cur.parentPath) : undefined;
    }
  }
  const kids = new Map<string, ImapFolderInfo[]>();
  const top: ImapFolderInfo[] = [];
  for (const f of folders) {
    if (!shown.has(f.path)) continue;
    if (f.parentPath && shown.has(f.parentPath)) {
      const list = kids.get(f.parentPath) ?? [];
      list.push(f);
      kids.set(f.parentPath, list);
    } else {
      top.push(f);
    }
  }
  const node = (f: ImapFolderInfo): FolderNode => ({
    id: f.path,
    name: leaf(f),
    hasChildren: kids.has(f.path),
  });
  const optIds = new Set(optIns.map((n) => n.id));
  return {
    roots: [...top.map(node), ...optIns],
    children: (id) => (kids.get(id) ?? []).map(node),
    expand(selectedIds) {
      const skip = new Set(selectedIds);
      const out: string[] = [];
      for (const id of selectedIds) {
        let p = cand.get(id)?.parentPath;
        while (p && shown.has(p)) {
          if (!skip.has(p) && !out.includes(p)) out.push(p);
          p = cand.get(p)?.parentPath;
        }
      }
      return out;
    },
    offers: (id) => shown.has(id) || optIds.has(id),
  };
}

function isNonExistent(f: ImapFolderInfo): boolean {
  return f.flags.includes('\\nonexistent');
}

/** Holds no messages: never synced. */
function unsyncable(f: ImapFolderInfo): boolean {
  return f.flags.includes('\\noselect') || isNonExistent(f);
}

/** Last path segment: split on the delimiter, else on / or . (see folders.ts). */
function leaf(f: ImapFolderInfo): string {
  const parts = f.delimiter ? f.path.split(f.delimiter) : f.path.split(/[/.]/);
  return parts[parts.length - 1];
}

function seps(delimiter: string | undefined): string[] {
  return delimiter ? [delimiter] : ['/', '.'];
}

/** INBOX is case-insensitive per RFC 3501; fold its leading segment only. */
function norm(path: string, delimiter: string | undefined): string {
  if (path.slice(0, 5).toUpperCase() !== 'INBOX') return path;
  const next = path.charAt(5);
  return next === '' || seps(delimiter).includes(next)
    ? 'INBOX' + path.slice(5)
    : path;
}

function isRoot(roots: FolderRootSelection[], f: ImapFolderInfo): boolean {
  return roots.some((r) => samePath(r.id, f.path));
}

function samePath(rootId: string, path: string): boolean {
  return norm(rootId, undefined) === norm(path, undefined);
}

/** Does this root select the mailbox: same path or an ancestor of it. */
function covers(rootId: string, f: ImapFolderInfo): boolean {
  const r = norm(rootId, f.delimiter);
  const p = norm(f.path, f.delimiter);
  return p === r || seps(f.delimiter).some((s) => p.startsWith(r + s));
}

function specialPathsOf(folders: ImapFolderInfo[]): ImapFolderInfo[] {
  return folders.filter((f) => specialKind(f) !== null);
}

/** Inside a special folder (e.g. Trash/Old): hidden and never covered. */
function underSpecial(f: ImapFolderInfo, specials: ImapFolderInfo[]): boolean {
  return specials.some(
    (s) =>
      s !== f && seps(f.delimiter).some((d) => f.path.startsWith(s.path + d)),
  );
}
