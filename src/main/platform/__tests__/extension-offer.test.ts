/** @jest-environment node */
/** Step 5 Task 5: a join offer carries the joiner's connectors and the master
 *  adds the ones its set lacks (spec 7.9 rule 6). */
import {
  createExtensionSync,
  type ExtensionOps,
  type ExtensionSetStore,
  type ExtensionsSet,
  type LocalExtension,
} from '../extension-set';

function store(initial?: ExtensionsSet, writable = true) {
  let value = initial;
  const s: ExtensionSetStore & { value(): ExtensionsSet | undefined; writable: boolean } = {
    writable,
    value: () => value,
    get: () => value,
    canWrite: () => s.writable,
    async update(fn) {
      if (!s.writable) throw new Error('read only');
      const next = fn(value);
      if (next !== undefined) value = next;
    },
  };
  return s;
}

const ops = (local: LocalExtension[]): ExtensionOps => ({
  list: () => local,
  setEnabled: async () => ({ ok: true }),
  installFromRef: async () => ({ ok: true }),
  uninstall: async () => ({ ok: true }),
});

const slack: LocalExtension = {
  id: 'kia.slack', origin: 'marketplace', enabled: true, ref: 'github:kia-plugins/slack@v2',
};
const dev: LocalExtension = { id: 'kia.mine', origin: 'dev', enabled: true, ref: '/Users/me/plugin' };

describe('offer', () => {
  it('lists marketplace installs with their refs and switched bundled ones, never a dev install', () => {
    const sync = createExtensionSync({
      store: store(),
      ops: ops([
        slack,
        dev,
        { id: 'kiagent.people', origin: 'bundled', enabled: false, explicit: true },
        { id: 'kiagent.messages', origin: 'bundled', enabled: true },
      ]),
      log: () => {},
    });
    expect(sync.offer()).toEqual({
      'kia.slack': { enabled: true, ref: 'github:kia-plugins/slack@v2' },
      'kiagent.people': { enabled: false },
    });
  });
});

describe('union', () => {
  const mk = (st: ReturnType<typeof store>, local: LocalExtension[] = []) =>
    createExtensionSync({ store: st, ops: ops(local), log: () => {} });

  it('adds the connectors the set lacks and keeps every entry it has', async () => {
    const st = store({ 'kia.slack': { enabled: false, ref: 'github:kia-plugins/slack@v3' } });
    const added = await mk(st).union({
      'kia.slack': { enabled: true, ref: 'github:kia-plugins/slack@v2' },
      'kia.notion': { enabled: true, ref: 'github:kia-plugins/notion@v1' },
    });
    expect(added).toEqual(['kia.notion']);
    expect(st.value()).toEqual({
      'kia.slack': { enabled: false, ref: 'github:kia-plugins/slack@v3' },
      'kia.notion': { enabled: true, ref: 'github:kia-plugins/notion@v1' },
    });
  });

  it('starts from what the master holds when it never had a set', async () => {
    const st = store(undefined);
    const added = await mk(st, [slack]).union({
      'kia.notion': { enabled: true, ref: 'github:kia-plugins/notion@v1' },
    });
    expect(added).toEqual(['kia.notion']);
    expect(st.value()).toEqual({
      'kia.slack': { enabled: true, ref: 'github:kia-plugins/slack@v2' },
      'kia.notion': { enabled: true, ref: 'github:kia-plugins/notion@v1' },
    });
  });

  it('is a no-op when nothing is missing, and never removes by absence', async () => {
    const st = store({ 'kia.slack': { enabled: true, ref: 'x' }, 'kia.gone': { enabled: true } });
    expect(await mk(st).union({ 'kia.slack': { enabled: false } })).toEqual([]);
    expect(Object.keys(st.value()!).sort()).toEqual(['kia.gone', 'kia.slack']);
    expect(st.value()!['kia.slack']).toEqual({ enabled: true, ref: 'x' });
  });

  it('drops malformed entries and refs that are local paths', async () => {
    const st = store({});
    const added = await mk(st).union({
      'kia.a': { enabled: 'yes' },
      'kia.b': { enabled: true, ref: 42 },
      'kia.c': { enabled: true, ref: '/Users/me/plugin' },
      'kia.d': { enabled: true, ref: 'C:\\plugins\\d' },
      'kia.e': { enabled: true, ref: './rel' },
      'kia.f': { enabled: true, ref: 'github:kia-plugins/f@v1' },
      'kiagent.people': { enabled: false },
    } as never);
    expect(added.sort()).toEqual(['kia.f', 'kiagent.people']);
  });

  it('rejects on a device that can not write the set', async () => {
    await expect(mk(store({}, false)).union({ 'kia.a': { enabled: true } })).rejects.toThrow();
  });
});
