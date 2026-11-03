/** The user's extensions follow them to every device (alpha-cent spec 7.9
 *  rules 7-9). `core.extensions` holds `{ id: { enabled, ref? } }`; the leader
 *  rewrites it from the three actions, and every device reconciles itself to
 *  it. This module is the logic; the platform supplies the ops and the store. */

export type ExtensionsSet = Record<string, { enabled: boolean; ref?: string }>;

/** The `user_prefs` key that holds the set. */
export const EXTENSIONS_KEY = 'core.extensions';

export interface LocalExtension {
  id: string;
  origin: 'bundled' | 'marketplace' | 'dev';
  enabled: boolean;
  /** The pinned marketplace ref from installed.json. */
  ref?: string;
  /** state.json has an entry for it (a bundled extension's default is on). */
  explicit?: boolean;
}

export interface ExtensionSetStore {
  get(): ExtensionsSet | undefined;
  /** Atomic read-modify-write; `fn` sees the current value (undefined when no
   *  one ever set it) and returns the next, or undefined to leave it. Rejects
   *  on a device that can't write the table. */
  update(
    fn: (cur: ExtensionsSet | undefined) => ExtensionsSet | undefined,
  ): Promise<void>;
  canWrite(): boolean;
}

export interface ExtensionOps {
  list(): LocalExtension[];
  setEnabled(
    id: string,
    enabled: boolean,
  ): Promise<{ ok: boolean; error?: string }>;
  /** Installs the pinned ref and records its consent here, without a prompt:
   *  the user granted it on another of their devices. */
  installFromRef(
    ref: string,
    opts: { grantConsent: true },
  ): Promise<{ ok: boolean; id?: string; error?: string }>;
  uninstall(id: string): Promise<{ ok: boolean; error?: string }>;
}

export interface ReconcileResult {
  installed: string[];
  failed: { id: string; error: string }[];
}

/** What this device holds, as a set. Marketplace installs carry their ref;
 *  bundled extensions appear only once someone switched them. A dev install
 *  (a local path) is this machine's own. */
export function setFromLocal(local: LocalExtension[]): ExtensionsSet {
  const out: ExtensionsSet = {};
  for (const e of local) {
    if (e.origin === 'marketplace') {
      out[e.id] = e.ref
        ? { enabled: e.enabled, ref: e.ref }
        : { enabled: e.enabled };
    } else if (e.origin === 'bundled' && e.explicit) {
      out[e.id] = { enabled: e.enabled };
    }
  }
  return out;
}

export function createExtensionSync(d: {
  store: ExtensionSetStore;
  ops: ExtensionOps;
  log: (message: string) => void;
}) {
  const { store, ops } = d;
  let failedNow: { id: string; error: string }[] = [];
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const r = chain.then(fn);
    chain = r.catch(() => undefined);
    return r;
  };

  const reconcileNow = async (set: ExtensionsSet): Promise<ReconcileResult> => {
    const installed: string[] = [];
    const failed: { id: string; error: string }[] = [];
    const fail = (id: string, error?: string): void => {
      failed.push({ id, error: error ?? 'unknown error' });
    };
    const local = new Map(ops.list().map((e) => [e.id, e]));
    for (const [id, want] of Object.entries(set)) {
      const have = local.get(id);
      if (!have) {
        if (!want.ref) continue; // a bundled extension this build doesn't ship
        const r = await ops.installFromRef(want.ref, { grantConsent: true });
        if (!r.ok) {
          fail(id, r.error);
          continue;
        }
        installed.push(id);
        if (!want.enabled) {
          const s = await ops.setEnabled(id, false);
          if (!s.ok) fail(id, s.error);
        }
      } else if (have.enabled !== want.enabled) {
        const s = await ops.setEnabled(id, want.enabled);
        if (!s.ok) fail(id, s.error);
      }
    }
    for (const have of local.values()) {
      if (have.origin !== 'marketplace' || have.id in set) continue;
      const r = await ops.uninstall(have.id);
      if (!r.ok) fail(have.id, r.error);
    }
    failedNow = failed;
    for (const f of failed)
      d.log(`extension ${f.id} could not be brought in line: ${f.error}`);
    return { installed, failed };
  };

  const base = (cur: ExtensionsSet | undefined): ExtensionsSet =>
    cur ?? setFromLocal(ops.list());

  return {
    /** Bring this device in line with `set`. One at a time; a second call
     *  waits and finds nothing left to do. */
    reconcile: (set: ExtensionsSet): Promise<ReconcileResult> =>
      serial(() => reconcileNow(set)),
    /** Reconcile to whatever the table holds; nothing before a set exists. */
    runFromStore: (): Promise<ReconcileResult> =>
      serial(async () => {
        const set = store.get();
        if (!set) return { installed: [], failed: [] };
        return reconcileNow(set);
      }),
    /** The connectors the last reconcile could not install here. */
    failed: (): { id: string; error: string }[] =>
      failedNow.map((f) => ({ ...f })),
    /** Once, on a device that can write: the set from what is installed now.
     *  An existing row is never replaced. */
    seed: async (): Promise<void> => {
      if (!store.canWrite()) return;
      await store.update((cur) => (cur ? undefined : setFromLocal(ops.list())));
    },
    recordEnabled: async (id: string, enabled: boolean): Promise<void> => {
      if (!store.canWrite()) return;
      await store.update((cur) => {
        const next = { ...base(cur) };
        const have = next[id];
        const entry = ops.list().find((e) => e.id === id);
        if (!have && entry?.origin === 'dev') return cur;
        next[id] = {
          ...(have ?? (entry?.ref ? { ref: entry.ref } : {})),
          enabled,
        };
        return next;
      });
    },
    recordInstalled: async (
      id: string,
      ref: string | undefined,
    ): Promise<void> => {
      if (!ref || !store.canWrite()) return;
      await store.update((cur) => ({
        ...base(cur),
        [id]: { enabled: true, ref },
      }));
    },
    recordUninstalled: async (id: string): Promise<void> => {
      if (!store.canWrite()) return;
      await store.update((cur) => {
        const next = { ...base(cur) };
        delete next[id];
        return next;
      });
    },
  };
}
