/**
 * @jest-environment node
 *
 * The folder-scope contract surface, pinned in the one place three consumers
 * agree: core, the connector SDK (whose `scripts/generate.mjs` copyFileSync's
 * `contracts.ts` verbatim — `sdk/connector-sdk/scripts/generate.mjs:9-11`) and
 * the renderer.
 *
 * Half of this file is a TYPE test. ts-jest compiles with diagnostics on, so a
 * missing export or a mis-shaped declaration fails the suite before a single
 * expect() runs — that is the honest red for a contract change. The other half
 * is runtime: it asserts the new descriptor and capability flags survive the
 * extension-host wire (structuredClone, which is what `utilityProcess`'s
 * `child.postMessage` performs — `platform/transport.ts:153`) and both renderer
 * wires — `push:connect`, structured-cloned to every window from `main.ts:927`,
 * and `sources:list` (`ipc.ts:197` → `main.ts:403`), which is where C-9's
 * `SourceDescriptor.hasReauthenticate` reaches the Reconnect routing.
 *
 * `@jest-environment node` is load-bearing, not decoration: this repo's jsdom
 * is 20.0.3, whose global has NO `structuredClone` (measured:
 * `typeof structuredClone === 'undefined'` under the default jsdom env), and
 * the extension host is a Node process anyway.
 */
import type {
  Account,
  AccountId,
  Document,
  DocumentInput,
  FolderNode,
  FolderRootSelection,
  FolderScopeUpdate,
  FolderScopedConfig,
  FolderSelectionChannel,
  SourceDescriptor,
} from '../contracts';
import type { ChildToMain, Contributions } from '../extension-rpc';
import type { ConnectEvent } from '../ipc';

const ROOT: FolderRootSelection = { id: 'root', name: 'My Drive' };

const DESCRIPTOR: SourceDescriptor = {
  id: 'google-docs',
  name: 'Google Drive',
  documentTypes: ['file'],
  auth: 'oauth',
  folderScope: true,
};

const CONTRIBUTIONS: Contributions = {
  sources: [
    {
      descriptor: DESCRIPTOR,
      hasFetchBytes: true,
      hasReconcile: true,
      hasManageFolders: true,
      hasReauthenticate: true,
    },
  ],
  tools: [],
  senders: [],
};

describe('FolderScopedConfig is a type alias, not an interface', () => {
  it('assigns straight into Account.config (an interface is TS2322 here)', () => {
    const scoped: FolderScopedConfig = { folderRoots: [ROOT] };
    // The entire reason DECISIONS.md freezes this as a `type`: Account.config
    // is Record<string, unknown>, and only a type alias gets the implicit
    // index signature that makes this assignment legal.
    const asAccountConfig: Account['config'] = scoped;
    expect(asAccountConfig.folderRoots).toEqual([ROOT]);
  });

  it('keeps folderRoots typed through the Record intersection', () => {
    const update: FolderScopeUpdate<{ page_token: string }> = {
      config: { folderRoots: [ROOT], watch: true },
      cursor: { page_token: 'tok' },
      archiveScopeRootIds: [],
    };
    // `Record<string, unknown> & FolderScopedConfig` must NOT collapse
    // folderRoots to `unknown`; an unrelated key still rides along.
    const roots: FolderRootSelection[] = update.config.folderRoots;
    expect(roots).toEqual([ROOT]);
    expect(update.config.watch).toBe(true);
    expect(update.cursor).toEqual({ page_token: 'tok' });
  });
});

describe('FolderScopeUpdate carries R8 archive set', () => {
  it('carries the source-computed ids that leave scope', () => {
    const update: FolderScopeUpdate<null> = {
      config: { folderRoots: [ROOT] },
      cursor: null,
      archiveScopeRootIds: ['dropped-a', 'dropped-b'],
    };
    expect(update.archiveScopeRootIds).toEqual(['dropped-a', 'dropped-b']);
  });

  it('accepts an EMPTY archive set — R8/A-1: the safe default', () => {
    // Drive-with-catch-all and OneDrive-with-a-covering-retained-root both
    // return []. Empty means "archive nothing"; it is never an error.
    const update: FolderScopeUpdate<null> = {
      config: { folderRoots: [ROOT] },
      cursor: null,
      archiveScopeRootIds: [],
    };
    expect(update.archiveScopeRootIds).toEqual([]);
  });

  it('REQUIRES archiveScopeRootIds — the pre-R8 two-field shape must not compile', () => {
    const partial = {
      config: { folderRoots: [ROOT] },
      cursor: null,
    };
    // @ts-expect-error -- R8/A-1: archiveScopeRootIds is required. If this
    // line stops erroring, the field was made optional and every connector's
    // computed archive set is silently discardable.
    const preR8: FolderScopeUpdate<null> = partial;
    expect(Object.keys(preR8).sort()).toEqual(['config', 'cursor']);

    // The three REQUIRED keys, and no fourth: `archiveNullScoped` is optional
    // (C-1), so a source that does not request the NULL repair simply omits
    // it — Task 8's local-folder return is exactly this shape.
    const required: FolderScopeUpdate<null> = {
      ...partial,
      archiveScopeRootIds: [],
    };
    expect(Object.keys(required).sort()).toEqual([
      'archiveScopeRootIds',
      'config',
      'cursor',
    ]);
  });

  it('ACCEPTS the optional field reattributeScopeRoots and keeps it disjoint from the archive set (C-46/D5)', () => {
    // The third verb: "this removed root's documents are STILL in scope,
    // under a retained one". Neither "archive it" nor silence is correct
    // there — the first forces a re-download and a searchability gap, the
    // second freezes a stale stamp forever (C-46/D2, C-46/D3).
    const update: FolderScopeUpdate<null> = {
      config: { folderRoots: [ROOT] },
      cursor: null,
      archiveScopeRootIds: ['gone'],
      reattributeScopeRoots: [{ from: 'moved', to: ROOT.id }],
    };
    expect(update.reattributeScopeRoots).toEqual([
      { from: 'moved', to: ROOT.id },
    ]);
    expect(Object.keys(update).sort()).toEqual([
      'archiveScopeRootIds',
      'config',
      'cursor',
      'reattributeScopeRoots',
    ]);

    // Optional: omitted is `undefined`, and the engine's coercion is `?? []`.
    const none: FolderScopeUpdate<null> = {
      config: { folderRoots: [ROOT] },
      cursor: null,
      archiveScopeRootIds: [],
    };
    expect(none.reattributeScopeRoots).toBeUndefined();
    expect(none.reattributeScopeRoots ?? []).toEqual([]);

    // The two arrays must be DISJOINT — `applyFolderScope` throws otherwise.
    // The type cannot express that, so the invariant is the store's and this
    // is only its statement in the contract's own vocabulary.
    const froms = new Set(
      (update.reattributeScopeRoots ?? []).map((r) => r.from),
    );
    expect(
      update.archiveScopeRootIds.filter((id) => froms.has(id)),
    ).toHaveLength(0);
  });

  it('ACCEPTS the optional fourth field archiveNullScoped (A-3 / C-1)', () => {
    // A-3: the flag is legal ONLY paired with a cursor that forces a full
    // re-establish. Drive's pairing is backfill_done:false with the page
    // token preserved; this literal is that shape.
    const repair: FolderScopeUpdate<{
      page_token: string;
      backfill_done: boolean;
    }> = {
      config: { folderRoots: [ROOT] },
      cursor: { page_token: 'tok', backfill_done: false },
      archiveScopeRootIds: [],
      archiveNullScoped: true,
    };
    expect(repair.archiveNullScoped).toBe(true);
    expect(Object.keys(repair).sort()).toEqual([
      'archiveNullScoped',
      'archiveScopeRootIds',
      'config',
      'cursor',
    ]);

    // Omitted is the default: `undefined`, never `true`. Task 3's
    // applyFolderScope input declares the flag REQUIRED, and C-1 puts the
    // coercion on the engine — this is the expression it uses.
    const noRepair: FolderScopeUpdate<null> = {
      config: { folderRoots: [ROOT] },
      cursor: null,
      archiveScopeRootIds: [],
    };
    expect(noRepair.archiveNullScoped).toBeUndefined();
    expect(noRepair.archiveNullScoped ?? false).toBe(false);
  });
});

describe('scopeRootId narrows from optional input to nullable stored', () => {
  it('accepts an input that omits it and a document that stores NULL', () => {
    // R5: an unresolvable root is NEVER a throw — the field is simply absent
    // on the way in and NULL in the store.
    const input: DocumentInput = {
      externalId: 'f1',
      type: 'file',
      title: 'q4.pdf',
      markdown: null,
      metadata: {},
      createdAt: null,
    };
    expect(input.scopeRootId).toBeUndefined();

    const attributed: DocumentInput = { ...input, scopeRootId: ROOT.id };
    expect(attributed.scopeRootId).toBe('root');

    const stored: Pick<Document, 'scopeRootId'> = { scopeRootId: null };
    expect(stored.scopeRootId).toBeNull();
  });
});

describe('FolderSelectionChannel is narrower than AuthChannel', () => {
  it('exposes status + pickFolders and nothing that can authenticate', () => {
    const calls: string[] = [];
    const channel: FolderSelectionChannel = {
      status: (msg) => calls.push(`status:${msg}`),
      pickFolders: async (spec) => spec.selected ?? [],
    };
    channel.status('Loading folders…');
    expect(calls).toEqual(['status:Loading folders…']);
    // A compile-time guarantee, asserted at runtime so the test has teeth:
    // there is no `oauth` verb to reach for.
    expect(Object.keys(channel).sort()).toEqual(['pickFolders', 'status']);
  });
});

describe('SourceDescriptor.folderScope crosses the extension-host wire', () => {
  it('survives the structuredClone utilityProcess.postMessage performs', () => {
    const activated: ChildToMain = {
      kind: 'activated',
      contributions: CONTRIBUTIONS,
    };
    const wire = structuredClone(activated);
    if (wire.kind !== 'activated') throw new Error('wrong variant');
    const entry = wire.contributions.sources[0];
    expect(entry.descriptor.folderScope).toBe(true);
    expect(entry.hasManageFolders).toBe(true);
    expect(entry.hasReauthenticate).toBe(true);
  });

  it('pins the exact per-source capability key set', () => {
    // A4: source-proxy.makeSource attaches optional methods ONLY behind these
    // flags (`platform/source-proxy.ts:261` fetchBytes, `:282` reconcile). A
    // new capability must land here as well as in the type, or the proxy
    // silently never exposes it.
    expect(Object.keys(CONTRIBUTIONS.sources[0]).sort()).toEqual([
      'descriptor',
      'hasFetchBytes',
      'hasManageFolders',
      'hasReauthenticate',
      'hasReconcile',
    ]);
  });
});

describe('SourceDescriptor.hasReauthenticate is CORE-populated (C-9)', () => {
  it('is optional — a connector-authored descriptor omits it', () => {
    // C-9: a value set in a manifest or a connector's own descriptor is
    // IGNORED. DESCRIPTOR above is connector-authored, so the field is absent.
    expect(DESCRIPTOR.hasReauthenticate).toBeUndefined();
  });

  it('survives the sources:list renderer wire for both answers', () => {
    // What `p.sources.list()` returns (`main.ts:403`) over
    // `'sources:list': { req: void; res: SourceDescriptor[] }` (`ipc.ts:197`),
    // structured-cloned through ipcMain. Task 7 stamps the flag in
    // `src/main/core/boot.ts:118`; Task 9 routes Reconnect on it, and the
    // `false` row is why an expired imap password is not dead-ended on Remove.
    const listed: SourceDescriptor[] = [
      { ...DESCRIPTOR, hasReauthenticate: true },
      {
        id: 'imap',
        name: 'IMAP',
        documentTypes: ['email'],
        auth: 'password',
        hasReauthenticate: false,
      },
    ];
    const wire = structuredClone(listed);
    expect(wire.map((d) => d.hasReauthenticate)).toEqual([true, false]);
  });
});

describe('ConnectEvent carries the preselection and the new terminals', () => {
  const flowId = 'flow-1';
  const selected: FolderNode[] = [
    { id: 'root', name: 'My Drive', hasChildren: true },
  ];

  it('folder-picker carries selected + purpose across the push wire', () => {
    const evt: ConnectEvent = {
      flowId,
      kind: 'folder-picker',
      requestId: 'p1',
      multiSelect: true,
      modes: [{ key: 'my-drive', label: 'My Drive' }],
      selected,
      purpose: 'manage',
    };
    const wire = structuredClone(evt);
    if (wire.kind !== 'folder-picker') throw new Error('wrong variant');
    expect(wire.purpose).toBe('manage');
    expect(wire.selected).toEqual(selected);
  });

  it('has terminals that do not abuse done{account}', () => {
    const accountId = 'a1' as AccountId;
    const reconnected: ConnectEvent = {
      flowId,
      kind: 'reconnected',
      accountId,
    };
    const saved: ConnectEvent = {
      flowId,
      kind: 'scope-saved',
      accountId,
      added: 1,
      retained: 2,
      removed: 3,
    };
    // B-1: every variant carries flowId — AddSourcePanel.tsx:83 routes on
    // `evt.flowId !== flowId`, a union-wide property access.
    expect([reconnected.flowId, saved.flowId]).toEqual([flowId, flowId]);
    if (saved.kind !== 'scope-saved') throw new Error('wrong variant');
    expect([saved.added, saved.retained, saved.removed]).toEqual([1, 2, 3]);
  });
});
