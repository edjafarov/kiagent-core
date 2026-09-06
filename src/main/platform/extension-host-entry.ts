/**
 * Extension host CHILD entry — the module utilityProcess forks (webpack
 * `extensionHost` entry; test forks run it via ts-node with
 * KIA_EXT_HOST_CHILD=1). Loads ONE extension bundle, hands it a remote-host
 * proxy whose every namespaced call crosses to main (where HostRouter — the
 * real gate — enforces caps), and runs its contributed sources/tools on
 * demand. Exports runExtensionHost for in-process tests; a bare import
 * starts nothing.
 */
import { createRequire } from 'module';

import type {
  DocumentInput,
  EventMeta,
  ExternalRef,
  ExtensionModule,
  FolderNode,
  FolderPickerSpec,
  McpTool,
  PullPhase,
  SendIntent,
  Sender,
  SenderContext,
  Source,
} from '@shared/contracts';
import type {
  ChildToMain,
  Contributions,
  ExtensionBootstrap,
  MainToChild,
} from '@shared/extension-rpc';
import { sourceErrorCode } from '@shared/source-errors';

import {
  createRpcEndpoint,
  type RpcEndpoint,
  type WireChannel,
} from './transport';

export interface ChildDeps {
  requireModule?(p: string): unknown;
  exit?(code: number): void;
  /** In-process privileged tier only: delivered to activate() as
   *  extras.mainProcess when bootstrap caps include 'unsafe.mainProcess'.
   *  A forked child never receives this — the cap is inert out-of-process. */
  mainApi?: unknown;
}

/** Exported for the drift guard (cap-table-completeness.test.ts), which
 *  compares each list against the real surface buildSurfaces() constructs. */
export const NS_METHODS: Record<string, string[]> = {
  query: [
    'search',
    'document',
    'children',
    'byExternalId',
    'count',
    'countBy',
    'accounts',
  ],
  net: ['fetch'],
  db: ['exec', 'query'],
  ui: ['notify'],
  inference: ['complete', 'see', 'read', 'hear', 'lane', 'describe'],
  files: ['list', 'read', 'write', 'move'],
  commands: ['register'],
};

function buildRemoteHost(
  endpoint: RpcEndpoint,
  boot: ExtensionBootstrap,
  eventCbs: Map<string, Set<(p: unknown, meta: EventMeta) => void>>,
): Record<string, unknown> {
  const host: Record<string, unknown> = {
    self: { id: boot.extensionId, dataDir: boot.dataDir },
    log: (level: unknown, msg: unknown) => {
      void endpoint.call('base', 'log', [level, msg]).catch(() => {});
    },
  };
  for (const cap of boot.caps) {
    if (cap === 'events') {
      host.events = {
        on(event: string, cb: (p: unknown, meta: EventMeta) => void) {
          let set = eventCbs.get(event);
          if (!set) {
            set = new Set();
            eventCbs.set(event, set);
            void endpoint.call('events', 'on', [event]).catch(() => {});
          }
          set.add(cb);
          return () => {
            set!.delete(cb);
            if (set!.size === 0) {
              eventCbs.delete(event);
              void endpoint.call('events', 'off', [event]).catch(() => {});
            }
          };
        },
        emit(event: string, payload: unknown) {
          void endpoint
            .call('events', 'emit', [event, payload])
            .catch(() => {});
        },
      };
      continue;
    }
    const methods = NS_METHODS[cap];
    if (!methods) continue; // caps without an RPC namespace (unsafe.mainProcess)
    const nsObj: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
    for (const m of methods) {
      nsObj[m] = (...args: unknown[]) => endpoint.call(cap, m, args);
    }
    host[cap] = nsObj;
  }
  return host;
}

export function runExtensionHost(
  channel: WireChannel,
  deps: ChildDeps = {},
): void {
  // A bare `require(p)` gets rewritten by webpack into a bundle-scoped
  // context module whose lookup can never hit an absolute on-disk path, so
  // the compiled child bundle would fail every extension load with "Cannot
  // find module". createRequire resolves against the real filesystem both
  // in the webpack artifact and un-bundled under jest/ts-node.
  const requireModule = deps.requireModule ?? createRequire(__filename);
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const endpoint = createRpcEndpoint(channel);

  let mod: ExtensionModule | null = null;
  const sources = new Map<string, Source>();
  const tools = new Map<string, McpTool>();
  // Keyed by SOURCE id, not by extension id — one source, one outbound
  // transport. Lives here (not in onBootstrap) so the onCall dispatcher,
  // registered once below, can reach it.
  const senders = new Map<string, Sender>();
  const eventCbs = new Map<
    string,
    Set<(p: unknown, meta: EventMeta) => void>
  >();
  // Task 8 fills these in: active pulls keyed by pullId.
  const pulls = new Map<
    number,
    {
      iterator: AsyncIterator<unknown>;
      abort: AbortController;
      source: Source;
      mode: 'batch' | 'refs';
    }
  >();
  // The open pickFolders spec per connect flow — its callbacks stay in the
  // child; main reads the tree back through picker-roots/-children/-count.
  const connectPickers = new Map<number, FolderPickerSpec>();
  // Same, for a manage-folders flow. A manage call has NO connectId: its
  // slot is keyed by the session id main allocated for the manage-folders
  // call. Kept as a second map rather than faking a connect flow so the
  // "already open" guard stays per-flow-kind and neither map's lifetime
  // depends on the other's.
  const managePickers = new Map<number, FolderPickerSpec>();

  const fail = (e: unknown) =>
    endpoint.post({
      kind: 'errored',
      error: e instanceof Error ? e.message : String(e),
    } satisfies ChildToMain);

  async function onBootstrap(boot: ExtensionBootstrap): Promise<void> {
    try {
      const loaded = requireModule(boot.entryAbsPath) as {
        default?: ExtensionModule;
      };
      mod = (loaded.default ?? loaded) as ExtensionModule;
      if (typeof mod.activate !== 'function')
        throw new Error('extension has no activate()');
      endpoint.post({ kind: 'ready' } satisfies ChildToMain);
      const host = buildRemoteHost(endpoint, boot, eventCbs);
      const extras =
        boot.caps.includes('unsafe.mainProcess') && deps.mainApi !== undefined
          ? { mainProcess: deps.mainApi }
          : undefined;
      const contrib = await mod.activate(host as never, extras);
      for (const s of contrib.sources ?? []) sources.set(s.descriptor.id, s);
      for (const t of contrib.tools ?? []) tools.set(t.name, t);
      for (const [sourceId, sender] of Object.entries(contrib.senders ?? {}))
        senders.set(sourceId, sender);
      const contributions: Contributions = {
        sources: [...sources.values()].map((s) => ({
          descriptor: s.descriptor,
          hasFetchBytes: typeof s.fetchBytes === 'function',
          hasReconcile: typeof s.reconcile === 'function',
          hasManageFolders: typeof s.manageFolders === 'function',
          hasReauthenticate: typeof s.reauthenticate === 'function',
        })),
        tools: [...tools.values()].map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
          tier: t.tier,
        })),
        senders: [...senders.keys()],
      };
      endpoint.post({ kind: 'activated', contributions } satisfies ChildToMain);
    } catch (e) {
      fail(e);
    }
  }

  endpoint.onCall(async (ns, method, args) => {
    if (ns === 'tool') {
      const tool = tools.get(method);
      if (!tool) throw new Error(`unknown tool ${method}`);
      return tool.call(args[0] as Record<string, unknown>);
    }
    if (ns === 'source') {
      return handleSourceCall(method, args); // Task 8
    }
    if (ns === 'send') {
      // `method` is the SOURCE id. Credentials arrive in ctx because an
      // out-of-process sender has no vault access of its own; main resolves
      // them at send time, after the confirmation gate.
      const sender = senders.get(method);
      if (!sender) throw new Error(`unknown sender ${method}`);
      return sender.send(
        args[0] as SendIntent,
        args[1] as SenderContext | undefined,
      );
    }
    throw new Error(`unexpected main→child namespace ${ns}`);
  });

  function makeSession(
    pullId: number,
    account: unknown,
    abort: AbortController,
  ) {
    return {
      account,
      signal: abort.signal,
      credentials: () => endpoint.call('session', 'credentials', [pullId]),
      log: (level: unknown, msg: unknown) => {
        void endpoint
          .call('session', 'log', [pullId, level, msg])
          .catch(() => {});
      },
    };
  }

  function toWireItems(source: Source, items: unknown[]): DocumentInput[] {
    const out: DocumentInput[] = [];
    for (const item of items) {
      const d = source.toDocument(item);
      if (d == null) continue;
      if (Array.isArray(d)) out.push(...d);
      else out.push(d);
    }
    return out;
  }

  /** The picker's DATA half, and the ONE place selected/purpose are
   *  defaulted. Callbacks stay child-side; anything not named here never
   *  reaches main (WirePickerSpec is a hand-written subset). */
  function toWirePickerSpec(spec: FolderPickerSpec) {
    return {
      modes: spec.modes,
      multiSelect: !!spec.multiSelect,
      hasCount: typeof spec.count === 'function',
      selected: spec.selected ?? [],
      expand: spec.expand ?? [],
      purpose: spec.purpose ?? ('connect' as const),
    };
  }

  /** Parks the real spec in `slot` so main's picker-* tree reads find it,
   *  and sends only display data across. Shared by the connect-time
   *  AuthChannel and the manage-time FolderSelectionChannel. */
  function pickFoldersOver(slot: Map<number, FolderPickerSpec>, id: number) {
    return async (spec: FolderPickerSpec): Promise<FolderNode[]> => {
      if (slot.has(id)) {
        throw new Error(
          'a folder picker is already open for this connect flow',
        );
      }
      slot.set(id, spec);
      try {
        // Only display data crosses; the callbacks stay here and main
        // calls back in through the picker-* source verbs below.
        return (await endpoint.call('auth', 'pickFolders', [
          id,
          toWirePickerSpec(spec),
        ])) as FolderNode[];
      } finally {
        slot.delete(id);
      }
    };
  }

  /** The full connect-time AuthChannel. Built here (not inline) because
   *  `reauthenticate` needs exactly the same object. */
  function makeAuthChannel(connectId: number) {
    return {
      oauth: (scopes: string[]) =>
        endpoint.call('auth', 'oauth', [connectId, scopes]),
      showQr: (qr: string) => {
        void endpoint.call('auth', 'showQr', [connectId, qr]).catch(() => {});
      },
      prompt: (schema: unknown) =>
        endpoint.call('auth', 'prompt', [connectId, schema]),
      status: (msg: string) => {
        void endpoint.call('auth', 'status', [connectId, msg]).catch(() => {});
      },
      pickFolders: pickFoldersOver(connectPickers, connectId),
    };
  }

  async function handleSourceCall(
    method: string,
    args: unknown[],
  ): Promise<unknown> {
    if (method === 'connect') {
      const [connectId, sourceId] = args as [number, string];
      const source = sources.get(sourceId);
      if (!source) throw new Error(`unknown source ${sourceId}`);
      return source.connect(makeAuthChannel(connectId) as never);
    }
    if (method === 'picker-roots') {
      const [connectId, mode] = args as [number, string];
      return pickerSpec(connectId).roots(mode);
    }
    if (method === 'picker-children') {
      const [connectId, id] = args as [number, string];
      return pickerSpec(connectId).children(id);
    }
    if (method === 'picker-count') {
      const [connectId, id] = args as [number, string];
      const spec = pickerSpec(connectId);
      return spec.count ? spec.count(id) : null;
    }
    if (method === 'pull-open') {
      const [pullId, sourceId, account, cursor] = args as [
        number,
        string,
        unknown,
        unknown,
      ];
      const source = sources.get(sourceId);
      if (!source) throw new Error(`unknown source ${sourceId}`);
      const abort = new AbortController();
      const session = makeSession(pullId, account, abort);
      const iterator = source
        .pull(session as never, cursor)
        [Symbol.asyncIterator]();
      pulls.set(pullId, { iterator, abort, source, mode: 'batch' });
      return null;
    }
    if (method === 'reconcile-open') {
      const [pullId, sourceId, account] = args as [number, string, unknown];
      const source = sources.get(sourceId);
      if (!source?.reconcile)
        throw new Error(`source ${sourceId} has no reconcile`);
      const abort = new AbortController();
      const session = makeSession(pullId, account, abort);
      const iterator = source
        .reconcile(session as never)
        [Symbol.asyncIterator]();
      pulls.set(pullId, { iterator, abort, source, mode: 'refs' });
      return null;
    }
    if (method === 'fetch-bytes') {
      const [sessionId, sourceId, account, doc] = args as [
        number,
        string,
        unknown,
        unknown,
      ];
      const source = sources.get(sourceId);
      if (!source?.fetchBytes)
        throw new Error(`source ${sourceId} has no fetchBytes`);
      const abort = new AbortController();
      const session = makeSession(sessionId, account, abort);
      return (await source.fetchBytes(session as never, doc as never)) ?? null;
    }
    if (method === 'manage-folders') {
      const [sessionId, sourceId, account] = args as [number, string, unknown];
      const source = sources.get(sourceId);
      if (!source?.manageFolders)
        throw new Error(`source ${sourceId} has no manageFolders`);
      const abort = new AbortController();
      const session = makeSession(sessionId, account, abort);
      // Narrower than AuthChannel BY CONSTRUCTION: there is no oauth /
      // prompt / showQr on this object to call, and main's FOLDER_VERBS
      // refuses them for this id anyway. "Manage never authenticates."
      const folderChannel = {
        status: (msg: string) => {
          void endpoint
            .call('auth', 'status', [sessionId, msg])
            .catch(() => {});
        },
        pickFolders: pickFoldersOver(managePickers, sessionId),
      };
      return source.manageFolders(session as never, folderChannel as never);
    }
    if (method === 'reauthenticate') {
      const [connectId, sourceId, account] = args as [number, string, unknown];
      const source = sources.get(sourceId);
      if (!source?.reauthenticate)
        throw new Error(`source ${sourceId} has no reauthenticate`);
      await source.reauthenticate(
        account as never,
        makeAuthChannel(connectId) as never,
      );
      return null; // Promise<void> — nothing to clone back
    }
    throw new Error(`unknown source method ${method}`);
  }

  function pickerSpec(id: number): FolderPickerSpec {
    // Ids come from ONE main-side counter (source-proxy's nextId), so a key
    // is unique across connect and manage flows and one lookup is safe.
    const spec = connectPickers.get(id) ?? managePickers.get(id);
    if (!spec) throw new Error('no active folder picker for this connect flow');
    return spec;
  }

  endpoint.onNotify((raw) => {
    const msg = raw as MainToChild;
    if (msg.kind === 'bootstrap') {
      void onBootstrap(msg);
      return;
    }
    if (msg.kind === 'event') {
      eventCbs.get(msg.name)?.forEach((cb) => cb(msg.payload, msg.meta));
      return;
    }
    if (msg.kind === 'src-next' || msg.kind === 'src-abort') {
      handleSourceNotify(msg); // Task 8
      return;
    }
    if (msg.kind === 'deactivate') {
      void (async () => {
        try {
          await mod?.deactivate?.();
        } catch {
          /* deactivate errors must not block exit */
        }
        pulls.forEach((p) => p.abort.abort());
        exit(0);
      })();
    }
  });

  function handleSourceNotify(msg: {
    kind: 'src-next' | 'src-abort';
    pullId: number;
  }): void {
    const pull = pulls.get(msg.pullId);
    if (!pull) return;
    if (msg.kind === 'src-abort') {
      pull.abort.abort();
      void pull.iterator.return?.(undefined).catch(() => {});
      pulls.delete(msg.pullId);
      return;
    }
    void (async () => {
      try {
        const r = await pull.iterator.next();
        if (r.done) {
          pulls.delete(msg.pullId);
          endpoint.post({
            kind: 'src-done',
            pullId: msg.pullId,
          } satisfies ChildToMain);
          return;
        }
        if (pull.mode === 'refs') {
          endpoint.post({
            kind: 'src-refs',
            pullId: msg.pullId,
            // The iterator is typed AsyncIterator<unknown> (it drives both
            // modes) — `mode` is what says which of the two shapes yielded.
            refs: r.value as ExternalRef[],
          } satisfies ChildToMain);
          return;
        }
        // Same untyped-iterator story as src-refs: the extension's own Batch
        // is only structurally known here, so it is asserted into the wire
        // shape at this one boundary rather than loosening WireBatch (which
        // would degrade every main-side consumer's typing for no gain).
        const b = r.value as {
          phase: PullPhase;
          items: unknown[];
          deletions?: ExternalRef[];
          cursor: unknown;
          estimateTotal?: number;
        };
        endpoint.post({
          kind: 'src-batch',
          pullId: msg.pullId,
          batch: {
            phase: b.phase,
            items: toWireItems(pull.source, b.items),
            deletions: b.deletions,
            cursor: b.cursor,
            estimateTotal: b.estimateTotal,
          },
        } satisfies ChildToMain);
      } catch (e) {
        pulls.delete(msg.pullId);
        // Forward the taxonomy code (if any) so main can rehydrate an error
        // that classifies like a bundled source's ('auth' → needsReauth).
        const code = sourceErrorCode(e);
        endpoint.post({
          kind: 'src-error',
          pullId: msg.pullId,
          error: e instanceof Error ? e.message : String(e),
          ...(code ? { code } : {}),
        } satisfies ChildToMain);
      }
    })();
  }
}

/** utilityProcess (parentPort) vs node fork (process.send) adapter. */
export function connectParentChannel(): WireChannel {
  const pp = (
    process as unknown as {
      parentPort?: {
        postMessage(m: unknown): void;
        on(ev: 'message', h: (e: { data: unknown }) => void): void;
        off(ev: 'message', h: (e: { data: unknown }) => void): void;
      };
    }
  ).parentPort;
  if (pp) {
    return {
      send: (m) => pp.postMessage(m),
      onMessage: (cb) => {
        const h = (e: { data: unknown }) => cb(e.data);
        pp.on('message', h);
        return () => pp.off('message', h);
      },
      close: () => {},
    };
  }
  return {
    send: (m) => process.send?.(m),
    onMessage: (cb) => {
      const h = (m: unknown) => cb(m);
      process.on('message', h);
      return () => {
        process.off('message', h);
      };
    },
    close: () => {},
  };
}

const isUtilityChild = Boolean(
  (process as unknown as { parentPort?: unknown }).parentPort,
);
if (isUtilityChild || process.env.KIA_EXT_HOST_CHILD === '1') {
  // Under stdio-less utilityProcess, console must not throw; reroute to stderr
  // like mcp/stdio-entry.ts does.
  // eslint-disable-next-line no-console
  console.log = console.error.bind(console);
  process.on('uncaughtException', (e) => {
    process.stderr.write(`[ext-host] uncaught: ${e.stack ?? e.message}\n`);
    process.exit(1);
  });
  process.on('unhandledRejection', (e) => {
    const detail = e instanceof Error ? (e.stack ?? e.message) : String(e);
    process.stderr.write(`[ext-host] unhandled: ${detail}\n`);
    process.exit(1);
  });
  runExtensionHost(connectParentChannel());
}
