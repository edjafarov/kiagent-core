import type {
  AppPrefs,
  AppState,
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
  processing(): Promise<{ pending: number; done: number; skipped: number; failed: number }>;
  extensions(): ExtensionSnapshot[];
}

const RECENT_MAX = 5;

/**
 * THE canonical renderer projection. Counts drift-tolerant by design: apply()
 * uses the ingestedAt === updatedAt heuristic for "new document" and archive
 * transitions for decrements; init() recomputes exactly on every (re)connect.
 */
export function createAppProjection(extras: AppStateExtras): Projection<AppState> {
  return {
    async init(read) {
      const accounts = await read.accounts();
      const entries = await Promise.all(
        accounts.map(async (account) => {
          const docCount = await read.count({ account: account.id });
          const docs = await read.search({ account: account.id, limit: RECENT_MAX });
          return {
            account,
            docCount,
            recent: docs.map((d) => ({
              id: d.id,
              title: d.title,
              ts: d.updatedAt,
            })),
          };
        }),
      );
      return {
        accounts: entries,
        processing: await extras.processing(),
        mcp: extras.mcp(),
        identity: await extras.identity(),
        prefs: extras.prefs(),
        extensions: extras.extensions(),
      };
    },

    apply(state, changes) {
      let accounts = state.accounts;
      for (const c of changes) {
        if (c.kind === 'account') {
          const i = accounts.findIndex((a) => a.account.id === c.account.id);
          accounts =
            i >= 0
              ? accounts.map((a, j) => (j === i ? { ...a, account: c.account } : a))
              : [...accounts, { account: c.account, docCount: 0, recent: [] }];
        } else if (c.kind === 'accountRemoved') {
          accounts = accounts.filter((a) => a.account.id !== c.accountId);
        } else if (c.kind === 'document') {
          const i = accounts.findIndex((a) => a.account.id === c.document.accountId);
          if (i < 0) continue;
          const entry = accounts[i];
          const isNew = c.document.ingestedAt === c.document.updatedAt;
          const archived = c.document.archivedAt !== null;
          const docCount = Math.max(
            0,
            entry.docCount + (archived ? -1 : isNew ? 1 : 0),
          );
          const recent = archived
            ? entry.recent.filter((r) => r.id !== c.document.id)
            : [
                { id: c.document.id, title: c.document.title, ts: c.document.updatedAt },
                ...entry.recent.filter((r) => r.id !== c.document.id),
              ].slice(0, RECENT_MAX);
          accounts = accounts.map((a, j) => (j === i ? { ...a, docCount, recent } : a));
        }
        // 'purge': account unknown from the tombstone alone — counts self-heal
        // on the next init().
      }
      return { ...state, accounts };
    },
  };
}
