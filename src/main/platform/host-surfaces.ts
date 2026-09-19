/**
 * The REAL capability implementations behind HostFor<G> namespaces — all
 * main-side; the child only holds proxies. One instance per extension per
 * host incarnation. files and commands are implemented here; only commands
 * outside the public capability surface are rejected by the router.
 */
import type { EventMeta, LaneState, LogLevel, Query } from '@shared/contracts';
import type { PluginDb, PluginDbParams, PluginDbStep } from '@shared/plugin-db';
import type { FileChange, ScopedFiles } from '@shared/plugin-files';
import type { AppDb } from '@main/db/app-db';
import type { DbOwner, TxToken } from '@main/db/coordinator';
import { pluginIdentifier } from '@shared/plugin-sql';
import type { LogSink } from '@main/core/engine/engine';
import type { AttentionService } from '@main/attention/service';
import { createNetworkService, type NetworkService } from './network-service';
import { HostCallInTransactionError } from './host-call-context';
import type { ManifestTier } from './manifest';
import { createUiRegistry, type UiRegistry } from './ui-registry';

export class CapError extends Error {}

export interface EventBus {
  emit(from: string, event: string, payload: unknown): void;
  subscribe(
    extensionId: string,
    event: string,
    deliver: (payload: unknown, meta: EventMeta) => void,
  ): () => void;
}

/** Delivery includes the emitter itself when subscribed — self-delivery is
 *  part of the contract. `logSink` is optional so every existing caller
 *  (tests included) keeps compiling unchanged; production wires the real
 *  one so a dead subscriber's failure is reported, not silent. */
export function createEventBus(logSink?: LogSink): EventBus {
  const subs = new Map<
    string,
    Set<(payload: unknown, meta: EventMeta) => void>
  >();
  return {
    emit(from, event, payload) {
      // Host-stamped, unforgeable provenance: `from` is exactly the first
      // argument this function received — never read from `payload`, never
      // defaulted, never something a subscriber can override. Every caller
      // of `emit` is the host itself (the events surface passes
      // `deps.extensionId`; the platform passes the literal 'platform') —
      // an extension never gets to call this function directly, only
      // through the surface, which is what makes `from` trustworthy.
      const meta: EventMeta = { from, at: Date.now() };
      // Isolate each subscriber: one extension must not be able to starve
      // event delivery for every other extension. Without this, a single
      // throwing callback (a dead transport's `endpoint.post`, the
      // realistic case — see host-process.ts's deliverEvent) would abort
      // `forEach` mid-iteration, silently dropping the event for every
      // subscriber registered AFTER the one that threw. That matters
      // doubly for `platform.lane`: its dedup already recorded the
      // transition as delivered (see createLaneGate in
      // extension-platform.ts) the instant `emit` was called, so a
      // fan-out abort here would drop it for the un-notified subscribers
      // PERMANENTLY — not just for this tick, until the next real
      // transition.
      subs.get(event)?.forEach((cb) => {
        try {
          cb(payload, meta);
        } catch (err) {
          logSink?.log(
            'platform',
            'warn',
            `event subscriber for '${event}' threw`,
            { error: String(err) },
          );
        }
      });
    },
    subscribe(_extensionId, event, deliver) {
      let set = subs.get(event);
      if (!set) {
        set = new Set();
        subs.set(event, set);
      }
      set.add(deliver);
      return () => {
        set!.delete(deliver);
      };
    },
  };
}

export type Surfaces = Record<
  string,
  Record<string, (...args: unknown[]) => unknown>
>;

export interface SurfaceDeps {
  extensionId: string;
  /** Retained only as host metadata; never used to open SQLite. */
  dataDir?: string;
  /** The one boot-owned worker service. There is deliberately no fallback
   *  database here: a host without an injected service is a wiring error. */
  appDb?: AppDb;
  owner?: DbOwner;
  /** Fresh per-incarnation services. Their owner signal is disposed with the
   *  surface bundle, so requests/watchers cannot outlive a host. */
  network?: NetworkService;
  files?: ScopedFiles & { dispose?: () => Promise<void> };
  query: Query;
  inference: {
    complete(
      prompt: string,
      opts?: {
        maxTokens?: number;
        lane?: 'interactive' | 'background';
        /** Deterministic decoding for classification-style prompts;
         *  'default' keeps today's behavior. Lifted from `InferencePlane`
         *  (src/main/core/inference.ts) — see `describe`/`generation`
         *  below for why a caller would pass these. */
        profile?: 'default' | 'deterministic';
        /** A separate system message, kept apart from the user prompt. */
        system?: string;
        /** A generation obtained from `describe()`. Rejected with
         *  ModelChangedError (by `name`, not `instanceof` — it crosses the
         *  extension RPC boundary) when the model changed since. */
        generation?: number;
      },
    ): Promise<string>;
    see(
      image: Uint8Array,
      prompt: string,
      opts?: { mime?: string; lane?: 'interactive' | 'background' },
    ): Promise<string>;
    read(
      image: Uint8Array,
      opts?: { mime?: string; lane?: 'interactive' | 'background' },
    ): Promise<string>;
    hear(
      audio: Uint8Array,
      opts?: {
        format?: 'wav' | 'mp3';
        timestamps?: boolean;
        vad?: 'required';
        language?: string;
        detectLanguage?: true;
        model?: 'accuracy';
        lane?: 'interactive' | 'background';
      },
    ): Promise<string>;
    /** The resolved LaneState (why the background lane is or isn't open
     *  right now), so an extension can wait for 'open' instead of hammering
     *  a closed background lane. Injected by the extension platform at
     *  surface-build time (`backgroundLaneState`) — the plane itself has no
     *  access to prefs/scheduler and cannot resolve this alone. */
    lane(): Promise<LaneState>;
    /** Resolves the provider that WOULD answer `kind` right now and reports
     *  its model identity plus the plane's current generation token — so
     *  an extension can compute a cache key BEFORE calling and later pass
     *  the generation back to `complete()` to be rejected if the model
     *  changed underneath it. `null` when no ready provider supports the
     *  kind; never throws. Injected by the extension platform straight
     *  from `InferencePlane.describe` — unlike `lane`, the plane can
     *  resolve this on its own, so no extra wiring is needed at
     *  surface-build time.
     *
     *  Optional, unlike `lane`: a defaulted `describe` cannot lie (`null`
     *  is already the documented, non-misleading answer for "no ready
     *  provider"), so a caller that omits it keeps compiling — the
     *  default is supplied once, in `buildSurfaces` below, rather than at
     *  every existing construction site. Contrast `laneState`
     *  (`ExtensionPlatformDeps`, task 1): a silent default there would
     *  report the background lane as OPEN, an affirmative false claim
     *  that could mask a real wiring bug — that is why `laneState` stayed
     *  required and this does not. */
    describe?(kind: 'complete' | 'see' | 'read' | 'hear'): Promise<{
      providerId: string;
      modelId: string;
      generation: number;
    } | null>;
  };
  attention: AttentionService;
  notify(msg: string, level?: LogLevel): void;
  bus: EventBus;
  /** Ships a host event to the child (endpoint.post({kind:'event',…})). */
  deliverEvent(name: string, payload: unknown, meta: EventMeta): void;
  deliverFileChange?(watchId: number, event: FileChange): void;
  /** B1: the shared registry behind `host.ui.handle/unhandle/broadcast`.
   *  Defaulted to a throwaway per-call instance when absent (the
   *  cap-table-completeness drift guard builds surfaces with no registry
   *  at all) — production always injects the ONE instance
   *  createExtensionPlatform owns, shared across every extension. */
  uiRegistry?: UiRegistry;
  /** Which manifest tier this extension was loaded under — decides whether
   *  `ui.handle`/`unhandle`/`broadcast` are denied (external tier). Comes
   *  from the host's OWN record of how the extension was loaded
   *  (`Entry.origin`), never from anything the extension itself sends.
   *  Defaults to the more restrictive 'external' when omitted, matching
   *  `parseManifest`'s own `opts.tier ?? 'external'` convention. */
  tier?: ManifestTier;
  /** This incarnation's lifecycle signal (host-process.ts's `lifecycle`
   *  AbortController). B1 listens for its abort to close ui registration
   *  SYNCHRONOUSLY at the start of teardown — `lifecycle.abort()` is the
   *  first statement of every teardown path (the exit handler's cleanup(),
   *  its catch-block twin, and stop()'s own abortSpawn()), so an abort
   *  listener registered here fires before anything else in that path
   *  runs, closing registration before a respawn's fresh makeSurfaces()
   *  call can even begin. */
  signal?: AbortSignal;
}

const unsupported = (ns: string) => () => {
  throw new CapError(
    `the '${ns}' capability is not supported in this build yet`,
  );
};

export function buildSurfaces(deps: SurfaceDeps): {
  surfaces: Surfaces;
  close(): void | Promise<void>;
} {
  const eventSubs = new Map<string, () => void>();
  const remoteWatchers = new Map<number, { close(): Promise<void> }>();
  const uiRegistry = deps.uiRegistry ?? createUiRegistry();
  // ONE resolution of the default, reused by both the registry bind (which
  // records tier per-registration) and the handle/unhandle/broadcast gate
  // below — two separate `?? 'external'` expressions could drift.
  const uiTier: ManifestTier = deps.tier ?? 'external';
  const uiIncarnation = uiRegistry.bind(
    deps.extensionId,
    // Only a drift-guard/unit test ever omits `owner` — production always
    // supplies one (host-process.ts mints a fresh DbOwner per spawn()).
    deps.owner?.handle ?? `${deps.extensionId}:no-owner`,
    uiTier,
  );
  // Synchronous, load-bearing: see SurfaceDeps.signal's doc comment. `once`
  // because `uiIncarnation.close()` is itself idempotent but there is no
  // reason to keep the listener alive past the first (and only) abort.
  //
  // `makeSurfaces` awaits a db open before calling this function, so
  // `deps.signal` can already be aborted by the time execution gets here —
  // an 'abort' listener attached to an ALREADY-fired AbortSignal never
  // fires (that is standard EventTarget behavior, not a bug in the
  // signal), so a listener-only registration would leave this incarnation's
  // ui registration open forever. Check the already-aborted case directly
  // instead of relying on the event.
  if (deps.signal?.aborted) uiIncarnation.close();
  else
    deps.signal?.addEventListener('abort', () => uiIncarnation.close(), {
      once: true,
    });
  const network =
    deps.network ??
    createNetworkService({
      owner: `extension:${deps.extensionId}`,
      log: () => undefined,
    });
  const { appDb } = deps;
  const { owner } = deps;
  const plugin = appDb?.plugin;
  const requireDb = () => {
    if (!plugin || !owner || owner.kind !== 'plugin')
      throw new CapError(
        'the db capability is unavailable: no worker owner is wired',
      );
    return { plugin, owner };
  };
  const dbCall = (
    request: Parameters<NonNullable<AppDb['plugin']>>[0],
    signal?: AbortSignal,
  ) => requireDb().plugin(request, { signal });

  function splitTransactionArgs(
    first: unknown,
    second: unknown,
    third: unknown,
  ): { token?: TxToken; sql: string; params?: PluginDbParams } {
    if (typeof first === 'string' && typeof second === 'string')
      return {
        token: first,
        sql: second,
        params: third as PluginDbParams | undefined,
      };
    return { sql: String(first), params: second as PluginDbParams | undefined };
  }

  const dbSurface = {
    identifier(name: string) {
      requireDb();
      return pluginIdentifier(deps.extensionId, String(name));
    },
    async exec(
      first: unknown,
      second?: unknown,
      third?: unknown,
      signal?: AbortSignal,
    ) {
      const call = splitTransactionArgs(first, second, third);
      await dbCall(
        {
          op: 'exec',
          owner: requireDb().owner,
          token: call.token,
          sql: call.sql,
          params: call.params,
        },
        signal,
      );
    },
    async query<Row = Record<string, unknown>>(
      first: unknown,
      second?: unknown,
      third?: unknown,
      signal?: AbortSignal,
    ): Promise<Row[]> {
      const call = splitTransactionArgs(first, second, third);
      return dbCall(
        {
          op: 'query',
          owner: requireDb().owner,
          token: call.token,
          sql: call.sql,
          params: call.params,
        },
        signal,
      ) as Promise<Row[]>;
    },
    async batch(first: unknown, second?: unknown, signal?: AbortSignal) {
      const token = Array.isArray(first) ? undefined : String(first);
      const steps = (token ? second : first) as readonly PluginDbStep[];
      return dbCall(
        { op: 'batch', owner: requireDb().owner, token, steps },
        signal,
      );
    },
    async migrate(
      module: string,
      version: number,
      statements: readonly string[],
      signal?: AbortSignal,
    ) {
      if (!appDb?.plugin)
        throw Object.assign(
          new Error('migration is not registered with the platform'),
          { code: 'PLUGIN_MIGRATION_NOT_REGISTERED' },
        );
      await dbCall(
        {
          op: 'migrate',
          owner: requireDb().owner,
          module,
          version,
          statements,
        },
        signal,
      );
    },
    async transaction<T>(work: (tx: PluginDb) => Promise<T>) {
      const { owner: dbOwner } = requireDb();
      const token = (await dbCall({ op: 'begin', owner: dbOwner })) as string;
      const tx = {
        exec: (sql: string, params?: PluginDbParams) =>
          dbSurface.exec(token, sql, params),
        query: <Row = Record<string, unknown>>(
          sql: string,
          params?: PluginDbParams,
        ) => dbSurface.query<Row>(token, sql, params),
        batch: (steps: readonly PluginDbStep[]) =>
          dbSurface.batch(token, steps),
      } as unknown as PluginDb;
      try {
        const value = await work(tx);
        await dbCall({ op: 'commit', owner: dbOwner, token });
        return value;
      } catch (error) {
        await dbCall({ op: 'rollback', owner: dbOwner, token }).catch(
          () => undefined,
        );
        throw error;
      }
    },
  };
  const fileCall = (method: string, args: unknown[]) => {
    if (!deps.files)
      throw new CapError(
        'the files capability is unavailable: no owner service is wired',
      );
    const fn = deps.files[method as keyof ScopedFiles] as unknown as (
      ...values: unknown[]
    ) => unknown;
    return fn(...args);
  };
  // The one place the optional dep is defaulted — every existing caller of
  // buildSurfaces() that doesn't wire `describe` keeps compiling, and the
  // default answers exactly what an absent provider would: `null`.
  const describeInference = deps.inference.describe ?? (async () => null);

  const surfaces: Surfaces = {
    query: {
      search: (q) => deps.query.search((q ?? {}) as never),
      document: (id) => deps.query.document(id as never),
      documentPage: (input) =>
        deps.query.documentPage?.(input as never) ?? Promise.resolve([]),
      children: (id) => deps.query.children(id as never),
      byExternalId: (account, externalId, type) =>
        deps.query.byExternalId(
          account as never,
          externalId as never,
          type as never,
        ),
      count: (q) => deps.query.count((q ?? {}) as never),
      countBy: (q) => deps.query.countBy((q ?? {}) as never),
      accounts: () => deps.query.accounts(),
    },
    net: {
      // Public internet destinations only — see net-guard.ts for why the
      // scheme check alone was not a boundary.
      fetch: (async (url: unknown, init: unknown, signal?: AbortSignal) => {
        return network.fetch(String(url), {
          ...(init as object),
          signal:
            signal ?? (init as { signal?: AbortSignal } | undefined)?.signal,
        });
      }) as unknown as (...args: unknown[]) => unknown,
    },
    db: {
      identifier: dbSurface.identifier as (...args: unknown[]) => unknown,
      begin: (...args: unknown[]) => {
        const signal = args[0] as AbortSignal | undefined;
        if (args[1] !== true) throw new HostCallInTransactionError('db');
        return dbCall({ op: 'begin', owner: requireDb().owner }, signal);
      },
      commit: (...args: unknown[]) => {
        const token = args[0];
        const transactionId = args[1] as string | undefined;
        const signal = args[2] as AbortSignal | undefined;
        if (String(token) !== transactionId)
          throw new HostCallInTransactionError('db');
        return dbCall(
          {
            op: 'commit',
            owner: requireDb().owner,
            token: String(token),
          },
          signal,
        );
      },
      rollback: (...args: unknown[]) => {
        const token = args[0];
        const transactionId = args[1] as string | undefined;
        const signal = args[2] as AbortSignal | undefined;
        if (String(token) !== transactionId)
          throw new HostCallInTransactionError('db');
        return dbCall(
          {
            op: 'rollback',
            owner: requireDb().owner,
            token: String(token),
          },
          signal,
        );
      },
      exec: dbSurface.exec as (...args: unknown[]) => unknown,
      query: dbSurface.query as (...args: unknown[]) => unknown,
      batch: dbSurface.batch as (...args: unknown[]) => unknown,
      migrate: dbSurface.migrate as (...args: unknown[]) => unknown,
    },
    ui: {
      // Stays all-tier — see the manifest doc's PRIVILEGED_CAPS note: `ui`
      // is NOT privileged, and an external manifest may already declare it
      // for notify alone. Only handle/unhandle/broadcast are gated below.
      notify: (msg, level) =>
        deps.notify(String(msg), level as LogLevel | undefined),
      // Synchronous throws here cross correctly: host-router's `dispatch`
      // is an async function, so a synchronous throw from `fn(...args)`
      // becomes a rejected promise exactly like an async one would — the
      // child's `host.ui.handle()` await sees it either way. Tier is
      // checked BEFORE the registry call so a denied external-tier
      // extension never even reaches the duplicate-name check (its own
      // information leak, however small, is not worth avoiding here since
      // the denial message says nothing about what else is registered).
      handle: (name: unknown) => {
        if (uiTier === 'external')
          throw new CapError(
            'ui.handle is not available for external-tier extensions',
          );
        uiIncarnation.handle(String(name));
      },
      unhandle: (name: unknown) => {
        if (uiTier === 'external')
          throw new CapError(
            'ui.unhandle is not available for external-tier extensions',
          );
        uiIncarnation.unhandle(String(name));
      },
      broadcast: (name: unknown, payload: unknown) => {
        if (uiTier === 'external')
          throw new CapError(
            'ui.broadcast is not available for external-tier extensions',
          );
        // Same structured-clone hazard as `ext:invoke`'s result (see
        // ext-invoke.ts): for an IN-PROCESS extension this payload has
        // crossed no serialization boundary yet, and `onUiBroadcast`'s ONE
        // relay (main.ts: `broadcast('ext:push', evt)`) hands it straight
        // to Electron's `webContents.send`, which clones it internally.
        // Reject HERE, synchronously, before it ever reaches the registry
        // or a subscriber — an unclonable broadcast must never throw deep
        // inside that relay (which is not this extension's call stack) or
        // silently ship a value every renderer receives as `{}`.
        try {
          structuredClone(payload);
        } catch (cloneError) {
          throw new CapError(
            `ui.broadcast payload is not structured-clone-safe: ${
              cloneError instanceof Error
                ? cloneError.message
                : String(cloneError)
            }`,
          );
        }
        uiIncarnation.broadcast(String(name), payload);
      },
    },
    inference: {
      // 'interactive' is only the DEFAULT — a caller-supplied `lane` in
      // opts survives the spread and overrides it, so 'background' passes
      // straight through to the plane (and fails fast with LaneClosedError
      // while that lane is closed, exactly like a core worker).
      complete: (prompt, opts) =>
        deps.inference.complete(String(prompt), {
          lane: 'interactive',
          ...(opts as object),
        }),
      see: (image, prompt, opts) =>
        deps.inference.see(image as Uint8Array, String(prompt), {
          lane: 'interactive',
          ...(opts as object),
        }),
      read: (image, opts) =>
        deps.inference.read(image as Uint8Array, {
          lane: 'interactive',
          ...(opts as object),
        }),
      hear: (audio, opts) =>
        deps.inference.hear(audio as Uint8Array, {
          lane: 'interactive',
          ...(opts as object),
        }),
      lane: () => deps.inference.lane(),
      describe: (kind) =>
        describeInference(kind as 'complete' | 'see' | 'read' | 'hear'),
    },
    events: {
      on(event) {
        const name = String(event);
        if (eventSubs.has(name)) return;
        eventSubs.set(
          name,
          deps.bus.subscribe(deps.extensionId, name, (p, meta) =>
            deps.deliverEvent(name, p, meta),
          ),
        );
      },
      off(event) {
        const name = String(event);
        eventSubs.get(name)?.();
        eventSubs.delete(name);
      },
      // LOAD-BEARING ARITY: exactly two declared parameters. host-router.ts
      // dispatches a hostile child's RPC call as `fn(...args)` with NO
      // arity check of its own, so a third array element a compromised
      // child pushes onto `args` (e.g. a forged `from`) is silently
      // dropped by JS call semantics rather than reaching this function —
      // that is the only thing standing between "an extension cannot
      // choose its own `from`" and a hole. Do not widen this signature
      // (e.g. to accept an emitter override) without re-establishing the
      // unforgeability guarantee some other way first.
      emit(event, payload) {
        const name = String(event);
        // The platform's own emits (extension.activated/deactivated) go
        // straight through bus.emit(), never through this surface — so
        // gating here (not in the bus) can't break them, only block an
        // extension from forging those names to peers.
        if (name.startsWith('extension.') || name.startsWith('platform.')) {
          throw new CapError(
            `event name '${name}' is reserved for platform-emitted events`,
          );
        }
        deps.bus.emit(deps.extensionId, name, payload);
      },
    },
    attention: {
      publish: (items: unknown) =>
        deps.attention.publish(deps.extensionId, items),
      resolve: (id: unknown, revision?: unknown) =>
        deps.attention.resolve(
          deps.extensionId,
          id as string,
          revision as number | undefined,
        ),
    },
    files: {
      roots: (...args) => fileCall('roots', args),
      stat: (...args) => fileCall('stat', args),
      lstat: (...args) => fileCall('lstat', args),
      canonical: (...args) => fileCall('canonical', args),
      mkdir: (...args) => fileCall('mkdir', args),
      open: (...args) => fileCall('open', args),
      fstat: (...args) => fileCall('fstat', args),
      readHandle: (...args) => fileCall('readHandle', args),
      writeHandle: (...args) => fileCall('writeHandle', args),
      syncHandle: (...args) => fileCall('syncHandle', args),
      setHandleMetadata: (...args) => fileCall('setHandleMetadata', args),
      closeHandle: (...args) => fileCall('closeHandle', args),
      link: (...args) => fileCall('link', args),
      list: (...args) => fileCall('list', args),
      read: (...args) => fileCall('read', args),
      write: (...args) => fileCall('write', args),
      move: (...args) => fileCall('move', args),
      remove: (...args) => fileCall('remove', args),
      watch: (...args) => {
        const [ref, callback] = args as [unknown, unknown];
        if (ref && typeof ref === 'object' && '__remoteWatchClose' in ref) {
          const watchId = Number(
            (ref as { __remoteWatchClose: unknown }).__remoteWatchClose,
          );
          const watcher = remoteWatchers.get(watchId);
          remoteWatchers.delete(watchId);
          return watcher?.close();
        }
        if (
          callback &&
          typeof callback === 'object' &&
          '__remoteWatchId' in callback
        ) {
          const watchId = Number(
            (callback as { __remoteWatchId: unknown }).__remoteWatchId,
          );
          const watcher = fileCall('watch', [
            ref,
            (event: FileChange) => deps.deliverFileChange?.(watchId, event),
          ]) as Promise<{ close(): Promise<void> }>;
          return watcher.then((handle) => {
            remoteWatchers.set(watchId, handle);
            return { watchId };
          });
        }
        return fileCall('watch', args);
      },
    },
    commands: { register: unsupported('commands') },
  };

  return {
    surfaces,
    async close() {
      // Idempotent backstop — the abort listener above is the load-bearing
      // synchronous path; this covers a caller that built surfaces with no
      // `signal` at all (tests) or that calls close() directly.
      uiIncarnation.close();
      eventSubs.forEach((off) => off());
      eventSubs.clear();
      await Promise.all(
        [...remoteWatchers.values()].map((watcher) =>
          watcher.close().catch(() => undefined),
        ),
      );
      remoteWatchers.clear();
      network.dispose();
      await deps.files?.dispose?.();
      if (plugin && owner && owner.kind === 'plugin')
        await plugin({ op: 'release', owner });
    },
  };
}
