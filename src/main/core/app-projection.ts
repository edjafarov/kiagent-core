import type {
  AccountId,
  AppPrefs,
  AppState,
  DocumentId,
  ExtensionSnapshot,
  Identity,
  Projection,
} from '@shared/contracts';

/** The non-feed slices of AppState, injected by boot. Feed-derived slices
 *  (accounts, counts, recents) come from init()/apply() only. */
export interface AppStateExtras {
  prefs(): AppPrefs;
  identity(): Promise<Identity | null>;
  mcp(): { port: number | null; clients: number };
  processing(): Promise<{
    pending: number;
    done: number;
    skipped: number;
    failed: number;
  }>;
  extensions(): ExtensionSnapshot[];
  /** The account's archived, not yet purged, document ids (store-level). When
   *  absent the projection starts with an empty archived index, and a restore
   *  of a document archived before init() is not counted back in. */
  archivedIds?(account: AccountId): Promise<DocumentId[]>;
}

const RECENT_MAX = 5;

/** Per account, the documents currently archived (not yet purged). */
type ArchivedIndex = ReadonlyMap<AccountId, ReadonlySet<DocumentId>>;
const NO_ARCHIVED: ArchivedIndex = new Map();

/** Copy-on-write edits to an ArchivedIndex: the input index (and the state it
 *  belongs to) is never mutated, so apply() stays pure. */
function draftIndex(base: ArchivedIndex) {
  let map: Map<AccountId, ReadonlySet<DocumentId>> | null = null;
  const owned = new Set<AccountId>();
  const own = (account: AccountId): Set<DocumentId> => {
    map ??= new Map(base);
    let set = map.get(account) as Set<DocumentId> | undefined;
    if (!owned.has(account)) {
      set = new Set(set);
      map.set(account, set);
      owned.add(account);
    }
    return set as Set<DocumentId>;
  };
  const current = () => map ?? base;
  return {
    has: (account: AccountId, id: DocumentId) =>
      current().get(account)?.has(id) ?? false,
    add: (account: AccountId, id: DocumentId) => own(account).add(id),
    remove: (account: AccountId, id: DocumentId) => own(account).delete(id),
    dropAccount(account: AccountId) {
      if (!current().has(account)) return;
      map ??= new Map(base);
      map.delete(account);
      owned.delete(account);
    },
    /** A purge tombstone names only the document, not its account. */
    purge(id: DocumentId) {
      for (const [account, set] of current()) {
        if (set.has(id)) own(account).delete(id);
      }
    },
    done: (): ArchivedIndex => current(),
  };
}

/**
 * THE canonical renderer projection. Counts drift-tolerant by design: init()
 * recomputes exactly on every (re)connect, and apply() adjusts by transition:
 *
 * - live → archived: -1; archived → live (a restore — a re-selected folder
 *   revives its rows in place, keeping their original ingestedAt): +1. Both
 *   are read off an index of the archived documents, seeded by init() and
 *   kept per state, so a replayed change counts once.
 * - any other live change: +1 only when ingestedAt === updatedAt, the "new
 *   document" heuristic.
 *
 * The index is held in a WeakMap keyed by the state object, not in AppState:
 * AppState is cloned to every window on every push, and a deselected folder
 * can leave thousands of archived ids behind.
 */
export function createAppProjection(
  extras: AppStateExtras,
): Projection<AppState> {
  const archivedOf = new WeakMap<AppState, ArchivedIndex>();
  return {
    async init(read) {
      const accounts = await read.accounts();
      const archived = new Map<AccountId, ReadonlySet<DocumentId>>();
      const entries = await Promise.all(
        accounts.map(async (account) => {
          const docCount = await read.count({ account: account.id });
          const docs = await read.search({
            account: account.id,
            limit: RECENT_MAX,
          });
          archived.set(
            account.id,
            new Set((await extras.archivedIds?.(account.id)) ?? []),
          );
          return {
            // Cursors never reach windows: the engine reads them via
            // store.account(); a large source cursor would otherwise be
            // cloned to every window on every batch.
            account: { ...account, cursor: null },
            docCount,
            recent: docs.map((d) => ({
              id: d.id,
              title: d.title,
              ts: d.updatedAt,
            })),
          };
        }),
      );
      const state: AppState = {
        accounts: entries,
        processing: await extras.processing(),
        mcp: extras.mcp(),
        identity: await extras.identity(),
        prefs: extras.prefs(),
        extensions: extras.extensions(),
        ready: true,
      };
      archivedOf.set(state, archived);
      return state;
    },

    apply(state, changes) {
      let { accounts } = state;
      const archived = draftIndex(archivedOf.get(state) ?? NO_ARCHIVED);
      for (const c of changes) {
        if (c.kind === 'account') {
          const projected = { ...c.account, cursor: null }; // see init()
          const i = accounts.findIndex((a) => a.account.id === c.account.id);
          accounts =
            i >= 0
              ? accounts.map((a, j) =>
                  j === i ? { ...a, account: projected } : a,
                )
              : [...accounts, { account: projected, docCount: 0, recent: [] }];
        } else if (c.kind === 'accountRemoved') {
          accounts = accounts.filter((a) => a.account.id !== c.accountId);
          archived.dropAccount(c.accountId);
        } else if (c.kind === 'document') {
          const i = accounts.findIndex(
            (a) => a.account.id === c.document.accountId,
          );
          if (i < 0) continue;
          const entry = accounts[i];
          const { accountId, id } = c.document;
          const wasArchived = archived.has(accountId, id);
          const isArchived = c.document.archivedAt !== null;
          let delta = 0;
          if (isArchived) {
            if (!wasArchived) {
              delta = -1;
              archived.add(accountId, id);
            }
          } else if (wasArchived) {
            delta = 1; // restored
            archived.remove(accountId, id);
          } else if (c.document.ingestedAt === c.document.updatedAt) {
            delta = 1; // new
          }
          const docCount = Math.max(0, entry.docCount + delta);
          const recent = isArchived
            ? entry.recent.filter((r) => r.id !== c.document.id)
            : [
                {
                  id: c.document.id,
                  title: c.document.title,
                  ts: c.document.updatedAt,
                },
                ...entry.recent.filter((r) => r.id !== c.document.id),
              ].slice(0, RECENT_MAX);
          accounts = accounts.map((a, j) =>
            j === i ? { ...a, docCount, recent } : a,
          );
        } else if (c.kind === 'purge') {
          // Only archived rows are purged, and they left the count when they
          // were archived.
          archived.purge(c.documentId);
        }
      }
      const next = { ...state, accounts };
      archivedOf.set(next, archived.done());
      return next;
    },
  };
}
