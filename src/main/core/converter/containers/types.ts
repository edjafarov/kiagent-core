/** Container expansion (spec section B): a mailbox, archive, address book
 *  or note export read BY PATH, page by page, in the converter child. */

export type ContainerKind = 'mbox' | 'zip' | 'vcard' | 'enex';

/** Bumped when a pager's output changes enough that expanded containers of
 *  that kind must be expanded again (a `done` record with an older `v` is
 *  treated as changed). */
export const EXPANDER_VERSION: Record<ContainerKind, number> = {
  mbox: 1,
  // 2: mailboxes, vCards and ENEX inside a ZIP are expanded (phase 2b).
  zip: 2,
  vcard: 1,
  enex: 1,
};

/** One child document, before the source adds its container prefix,
 *  parent, scope and markers. */
export interface ChildItem {
  /** `msg:<sha1>` | `zip:<member>` | `vcf:<id>` | `enex:<sha1>` — the
   *  externalId is `<container externalId>#<key>`. */
  key: string;
  type: 'email.message' | 'file' | 'contact.card' | 'note';
  title: string;
  markdown: string | null;
  metadata: Record<string, unknown>;
  createdAt: string | null;
}

export interface ExpandBudget {
  items: number;
  /** Rendered markdown bytes. */
  bytes: number;
  /** Wall clock, checked after each item; well inside the runner's 120 s
   *  whole-job timeout. */
  ms: number;
}

export const DEFAULT_EXPAND_BUDGET: ExpandBudget = {
  items: 200,
  bytes: 16 * 1024 * 1024,
  ms: 20_000,
};

export interface ExpandResult {
  items: ChildItem[];
  /** Opaque per-kind position for the next page; null when done. */
  resume: unknown | null;
  /** The container row's markdown, on the last page. */
  summary?: string;
  /** Last page only: the state to resume from if the file later grows by
   *  appending (mbox). The source keeps it on the `done` record. */
  tail?: unknown;
  /** The given `resume` no longer fits the file (an appended mailbox whose
   *  old end is not a message boundary): expand again from scratch. */
  restart?: true;
}

export function containerKindOf(
  filename: string,
  mime: string,
): ContainerKind | null {
  const base = filename.toLowerCase().split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  const ext = dot > 0 ? base.slice(dot + 1) : '';
  if (ext === 'mbox' || mime === 'application/mbox') return 'mbox';
  if (ext === 'zip') return 'zip';
  if (ext === 'vcf') return 'vcard';
  if (ext === 'enex') return 'enex';
  return null;
}
