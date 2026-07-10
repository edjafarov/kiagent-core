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
  ExtensionModule,
  FolderPickerSpec,
  McpTool,
  Source,
} from '@shared/contracts';
import type {
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

const NS_METHODS: Record<string, string[]> = {
  query: [
    'search',
    'document',
    'children',
    'byExternalId',
    'count',
    'accounts',
  ],
  net: ['fetch'],
  db: ['exec', 'query'],
  ui: ['notify'],
  inference: ['complete', 'see', 'read'],
  files: ['list', 'read', 'write', 'move'],
  commands: ['register'],
};

function buildRemoteHost(
  endpoint: RpcEndpoint,
  boot: ExtensionBootstrap,
  eventCbs: Map<string, Set<(p: unknown) => void>>,
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
        on(event: string, cb: (p: unknown) => void) {
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
  const eventCbs = new Map<string, Set<(p: unknown) => void>>();
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

  const fail = (e: unknown) =>
    endpoint.post({
      kind: 'errored',
      error: e instanceof Error ? e.message : String(e),
    });

  async function onBootstrap(boot: ExtensionBootstrap): Promise<void> {
    try {
      const loaded = requireModule(boot.entryAbsPath) as {
        default?: ExtensionModule;
      };
      mod = (loaded.default ?? loaded) as ExtensionModule;
      if (typeof mod.activate !== 'function')
        throw new Error('extension has no activate()');
      endpoint.post({ kind: 'ready' });
      const host = buildRemoteHost(endpoint, boot, eventCbs);
      const extras =
        boot.caps.includes('unsafe.mainProcess') && deps.mainApi !== undefined
          ? { mainProcess: deps.mainApi }
          : undefined;
      const contrib = await mod.activate(host as never, extras);
      for (const s of contrib.sources ?? []) sources.set(s.descriptor.id, s);
      for (const t of contrib.tools ?? []) tools.set(t.name, t);
      const contributions: Contributions = {
        sources: [...sources.values()].map((s) => ({
          descriptor: s.descriptor,
          hasFetchBytes: typeof s.fetchBytes === 'function',
          hasReconcile: typeof s.reconcile === 'function',
        })),
        tools: [...tools.values()].map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
          tier: t.tier,
        })),
      };
      endpoint.post({ kind: 'activated', contributions });
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

  function toWireItems(source: Source, items: unknown[]): unknown[] {
    const out: unknown[] = [];
    for (const item of items) {
      const d = source.toDocument(item);
      if (d == null) continue;
      if (Array.isArray(d)) out.push(...d);
      else out.push(d);
    }
    return out;
  }

  async function handleSourceCall(
    method: string,
    args: unknown[],
  ): Promise<unknown> {
    if (method === 'connect') {
      const [connectId, sourceId] = args as [number, string];
      const source = sources.get(sourceId);
      if (!source) throw new Error(`unknown source ${sourceId}`);
      const auth = {
        oauth: (scopes: string[]) =>
          endpoint.call('auth', 'oauth', [connectId, scopes]),
        showQr: (qr: string) => {
          void endpoint.call('auth', 'showQr', [connectId, qr]).catch(() => {});
        },
        prompt: (schema: unknown) =>
          endpoint.call('auth', 'prompt', [connectId, schema]),
        status: (msg: string) => {
          void endpoint
            .call('auth', 'status', [connectId, msg])
            .catch(() => {});
        },
        pickFolders: async (spec: FolderPickerSpec) => {
          if (connectPickers.has(connectId)) {
            throw new Error(
              'a folder picker is already open for this connect flow',
            );
          }
          connectPickers.set(connectId, spec);
          try {
            // Only display data crosses; the callbacks stay here and main
            // calls back in through the picker-* source verbs below.
            return await endpoint.call('auth', 'pickFolders', [
              connectId,
              {
                modes: spec.modes,
                multiSelect: !!spec.multiSelect,
                hasCount: typeof spec.count === 'function',
              },
            ]);
          } finally {
            connectPickers.delete(connectId);
          }
        },
      };
      return source.connect(auth as never);
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
    throw new Error(`unknown source method ${method}`);
  }

  function pickerSpec(connectId: number): FolderPickerSpec {
    const spec = connectPickers.get(connectId);
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
      eventCbs.get(msg.name)?.forEach((cb) => cb(msg.payload));
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
          endpoint.post({ kind: 'src-done', pullId: msg.pullId });
          return;
        }
        if (pull.mode === 'refs') {
          endpoint.post({
            kind: 'src-refs',
            pullId: msg.pullId,
            refs: r.value,
          });
          return;
        }
        const b = r.value as {
          phase: unknown;
          items: unknown[];
          deletions?: unknown;
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
        });
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
        });
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
