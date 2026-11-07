/** The fake extension set store and fake local ops the extension-set suites
 *  share (extension-set, extension-set-platform, extension-follow-e2e,
 *  settings-sync). */
import type {
  ExtensionOps,
  ExtensionSetStore,
  ExtensionsSet,
  LocalExtension,
} from '../../extension-set';

export function fakeStore(initial?: ExtensionsSet, writable = true) {
  let value: ExtensionsSet | undefined = initial;
  const store: ExtensionSetStore & { writes: number; writable: boolean; failNext: boolean; set(v: ExtensionsSet | undefined): void } = {
    writable,
    failNext: false,
    set(v) {
      value = v;
    },
    writes: 0,
    get: () => value,
    canWrite() {
      return this.writable;
    },
    async update(fn) {
      if (!this.writable) throw new Error('read only');
      if (this.failNext) {
        this.failNext = false;
        throw new Error('disk full');
      }
      const next = fn(value);
      if (next !== undefined && JSON.stringify(next) !== JSON.stringify(value)) {
        value = next;
        this.writes += 1;
      }
    },
  };
  return store;
}

/** `failAll`: every install fails 'offline' (a device that cannot download). */
export function fakeOps(initial: LocalExtension[], opts: { failAll?: boolean } = {}) {
  const local = new Map(initial.map((e) => [e.id, { ...e }]));
  const calls: string[] = [];
  const failInstall = new Set<string>();
  const ops: ExtensionOps & { calls: string[]; failInstall: Set<string>; local: typeof local } = {
    calls,
    failInstall,
    local,
    list: () => [...local.values()].map((e) => ({ ...e })),
    async setEnabled(id, enabled) {
      calls.push(`enable:${id}:${enabled}`);
      const e = local.get(id);
      if (!e) return { ok: false, error: 'none' };
      e.enabled = enabled;
      return { ok: true };
    },
    async installFromRef(ref, o) {
      calls.push(`install:${ref}:${o.grantConsent}`);
      const id = ref.replace(/^github:kia-plugins\//, 'kia.').replace(/@.*$/, '');
      if (opts.failAll || failInstall.has(id)) return { ok: false, error: 'offline' };
      local.set(id, { id, origin: 'marketplace', enabled: true, ref });
      return { ok: true, id };
    },
    async uninstall(id) {
      calls.push(`uninstall:${id}`);
      local.delete(id);
      return { ok: true };
    },
  };
  return ops;
}
