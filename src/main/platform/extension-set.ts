/** The user's extensions follow them to every device (alpha-cent spec 7.9
 *  rules 7-9). `core.extensions` holds `{ id: { enabled, ref? } }`; the leader
 *  rewrites it from the three actions, and every device reconciles itself to
 *  it. This module is the logic; the platform supplies the ops and the store. */

/** `removed: true` is a tombstone: the user uninstalled the connector, and
 *  every device uninstalls it too. Optional, so an older device ignores it. */
export type ExtensionsSet = Record<
  string,
  { enabled: boolean; ref?: string; removed?: true }
>;

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

export type PendingRecord =
  | { kind: 'enabled'; id: string; enabled: boolean }
  | { kind: 'installed'; id: string; ref: string | undefined }
  | { kind: 'uninstalled'; id: string; origin: 'marketplace' | 'dev' | 'bundled' };

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

/** An entry a join may add: well formed, and a marketplace ref or none. A
 *  local path is a dev install, and those are the joiner's own. */
function offerable(e: unknown): e is { enabled: boolean; ref?: string } {
  if (!e || typeof e !== 'object') return false;
  const { enabled, ref } = e as { enabled?: unknown; ref?: unknown };
  if (typeof enabled !== 'boolean') return false;
  if (ref === undefined) return true;
  return typeof ref === 'string' && ref.length > 0 && !/^([./\\~]|[A-Za-z]:|file:)/.test(ref);
}

/** Does `want` call for an install on this device? A missing connector installs
 *  from its ref (none: a bundled one this build doesn't ship); a marketplace one
 *  reinstalls when the pinned ref differs from the local one. */
export function needsInstall(have: LocalExtension | undefined, want: { ref?: string }): boolean {
  return !have ? !!want.ref : have.origin === 'marketplace' && !!want.ref && have.ref !== want.ref;
}

export function createExtensionSync(d: {
  store: ExtensionSetStore;
  ops: ExtensionOps;
  log: (message: string) => void;
}) {
  const { store, ops } = d;
  let failedNow: { id: string; error: string }[] = [];
  // One of two serial chains (prefs' is the other): `act -> updateCore ->
  // supersede -> discardQueued -> onQueueChange` crosses from this chain into
  // prefs' once and never back.
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const r = chain.then(fn);
    chain = r.catch(() => undefined);
    return r;
  };

  const pending = new Map<string, PendingRecord>();

  const reconcileNow = async (set: ExtensionsSet): Promise<ReconcileResult> => {
    const installed: string[] = [];
    const failed: { id: string; error: string }[] = [];
    const fail = (id: string, error?: string): void => {
      failed.push({ id, error: error ?? 'unknown error' });
    };
    const applyEnabled = async (id: string, want: boolean): Promise<void> => {
      const now = ops.list().find((e) => e.id === id);
      if (now && now.enabled === want) return;
      const s = await ops.setEnabled(id, want);
      if (!s.ok) fail(id, s.error);
    };
    const local = new Map(ops.list().map((e) => [e.id, e]));
    // Absence never uninstalls: a connector missing from the set is left alone.
    for (const [id, want] of Object.entries(set)) {
      // A user action here not yet in the set must not be reverted.
      const held = pending.get(id);
      if (held && held.kind === 'enabled' && want.removed) {
        // The removal came first; this enable can no longer apply.
        pending.delete(id);
        d.log(`extension ${id} was removed on another device; its pending enable is discarded`);
      } else if (held) continue;
      const have = local.get(id);
      // Before needsInstall: a tombstone never installs, whatever it carries.
      if (want.removed) {
        if (have?.origin !== 'marketplace') continue;
        const u = await ops.uninstall(id);
        // Refused (this device has the connector's accounts): keep it, disabled.
        // Already disabled means it was kept and reported by an earlier pass.
        if (!u.ok && have.enabled) {
          const s = await ops.setEnabled(id, false);
          if (!s.ok) fail(id, s.error);
          else fail(id, 'kept: this device has its accounts');
        }
        continue;
      }
      if (needsInstall(have, want)) {
        const r = await ops.installFromRef(want.ref!, { grantConsent: true });
        if (!r.ok) {
          fail(id, r.error);
          continue;
        }
        installed.push(id);
        await applyEnabled(id, want.enabled);
      } else if (have && have.enabled !== want.enabled) {
        // (no `have`: a bundled extension this build doesn't ship)
        const s = await ops.setEnabled(id, want.enabled);
        if (!s.ok) fail(id, s.error);
      }
    }
    failedNow = failed;
    for (const f of failed)
      d.log(`extension ${f.id} could not be brought in line: ${f.error}`);
    return { installed, failed };
  };

  const base = (cur: ExtensionsSet | undefined): ExtensionsSet =>
    cur ?? setFromLocal(ops.list());

  const recordEnabled = async (id: string, enabled: boolean): Promise<void> => {
      if (!store.canWrite()) return;
      await store.update((cur) => {
        const next = { ...base(cur) };
        const have = next[id];
        if (have?.removed) return cur;
        const entry = ops.list().find((e) => e.id === id);
        if (!have && entry?.origin === 'dev') return cur;
        next[id] = {
          ...(have ?? (entry?.ref ? { ref: entry.ref } : {})),
          enabled,
        };
        return next;
      });
  };
  const recordInstalled = async (
      id: string,
      ref: string | undefined,
  ): Promise<void> => {
      if (!ref || !store.canWrite()) return;
      await store.update((cur) => ({
        ...base(cur),
        [id]: { enabled: true, ref },
      }));
  };
  const recordUninstalled = async (
      id: string,
      origin: 'marketplace' | 'dev' | 'bundled',
  ): Promise<void> => {
      if (!store.canWrite()) return;
      await store.update((cur) => {
        if (origin !== 'marketplace') return cur;
        return { ...base(cur), [id]: { enabled: false, removed: true } };
      });
  };

  const applyRecord = async (p: PendingRecord): Promise<void> => {
    if (p.kind === 'enabled') return recordEnabled(p.id, p.enabled);
    if (p.kind === 'installed') return recordInstalled(p.id, p.ref);
    return recordUninstalled(p.id, p.origin);
  };
  const flushPending = async (): Promise<void> => {
    for (const [id, p] of [...pending]) {
      try {
        await applyRecord(p);
        pending.delete(id);
      } catch (e) {
        d.log(`extension ${id} still could not be recorded in the set: ${String(e)}`);
      }
    }
  };

  return {
    /** Bring this device in line with `set`. One at a time; a second call
     *  waits and finds nothing left to do. */
    reconcile: (set: ExtensionsSet): Promise<ReconcileResult> =>
      serial(async () => {
        await flushPending();
        return reconcileNow(set);
      }),
    /** Reconcile to whatever the table holds; nothing before a set exists. */
    runFromStore: (): Promise<ReconcileResult> =>
      serial(async () => {
        await flushPending();
        const set = store.get();
        if (!set) return { installed: [], failed: [] };
        return reconcileNow(set);
      }),
    /** The connectors the last reconcile could not install here. */
    failed: (): { id: string; error: string }[] =>
      failedNow.map((f) => ({ ...f })),
    /** Once, on a device that can write: the set from what is installed now.
     *  An existing row is never replaced. */
    seed: (): Promise<void> =>
      serial(async () => {
        if (!store.canWrite()) return;
        await store.update((cur) => (cur ? undefined : setFromLocal(ops.list())));
      }),
    /** A user action and its recording into the set, on the same queue as
     *  reconcile. The local op runs first; when it succeeded and the set could
     *  not be written, the record is kept for a retry and the call rejects. */
    act: <R extends { ok: boolean }>(
      op: () => Promise<R>,
      rec: (r: R) => PendingRecord | undefined,
    ): Promise<R> =>
      serial(async () => {
        const r = await op();
        if (!r.ok) return r;
        const p = rec(r);
        if (!p) return r;
        pending.set(p.id, p);
        try {
          await applyRecord(p);
          pending.delete(p.id);
        } catch (e) {
          throw new Error(
            `${p.id} was changed on this device but could not be recorded in the extension set (${e instanceof Error ? e.message : String(e)}); it will be retried`,
          );
        }
        return r;
      }),
    /** What this device would offer in a join: its marketplace installs with
     *  their refs and the bundled extensions someone switched. Never a dev
     *  (local-path) install. */
    offer: (): ExtensionsSet => {
      const have = store.get();
      return Object.fromEntries(
        Object.entries(setFromLocal(ops.list())).filter(([id]) => !have?.[id]?.removed),
      );
    },
    /** The master's half of a join: adds every offered entry the set lacks. An
     *  entry already in the set keeps its value; nothing is removed. Returns
     *  the ids added. */
    union: (offered: ExtensionsSet): Promise<string[]> =>
      serial(async () => {
        const added: string[] = [];
        await store.update((cur) => {
          added.length = 0;
          const next = { ...base(cur) };
          for (const [id, e] of Object.entries(offered ?? {})) {
            if (id in next || !offerable(e)) continue;
            next[id] = e.ref ? { enabled: e.enabled, ref: e.ref } : { enabled: e.enabled };
            added.push(id);
          }
          return added.length > 0 ? next : undefined;
        });
        return added;
      }),
    hasPending: (): boolean => pending.size > 0,
    recordEnabled,
    recordInstalled,
    recordUninstalled,
  };
}
