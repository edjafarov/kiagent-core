/**
 * Main-side Source proxies over a host RPC endpoint — what the engine
 * actually drives. toDocument is identity (the child pre-maps items), pull
 * is demand-driven (one src-next per batch — engine backpressure for free),
 * and the auth/session callback namespaces route here, keyed by the
 * stream/connect id allocated per operation.
 */
import type {
  AuthChannel,
  Batch,
  Credentials,
  Document,
  DocumentInput,
  ExternalRef,
  FolderCount,
  FolderNode,
  FolderPickerSpec,
  LogLevel,
  Session,
  Source,
} from '@shared/contracts';
import type { Contributions, WireBatch } from '@shared/extension-rpc';
import { sourceErrorCode, type SourceErrorCode } from '@shared/source-errors';

import type { RpcEndpoint } from './transport';

type Inbox =
  | { kind: 'batch'; batch: WireBatch }
  | { kind: 'refs'; refs: ExternalRef[] }
  | { kind: 'done' }
  | { kind: 'error'; error: string; code?: SourceErrorCode };

interface StreamState {
  inbox: Inbox[];
  wake: (() => void) | null;
}

// Explicit allowlist for the AuthChannel verbs the child may invoke — a
// bare bracket lookup on `auth` reaches the prototype chain (e.g. 'valueOf'
// resolves to Object.prototype.valueOf, which returns `auth` itself: not a
// promise, and unserializable back over the wire — an unhandled rejection
// in main instead of a clean error reply).
const AUTH_VERBS: ReadonlySet<string> = new Set([
  'oauth',
  'showQr',
  'prompt',
  'status',
  'pickFolders',
]);

/** What the child sends for pickFolders — the spec's callbacks stay in the
 *  child; main re-synthesizes them as picker-* calls back into it. */
interface WirePickerSpec {
  modes: Array<{ key: string; label: string }>;
  multiSelect: boolean;
  hasCount: boolean;
}

export interface SourceProxySet {
  handleCall(ns: string, method: string, args: unknown[]): Promise<unknown>;
  makeSource(entry: Contributions['sources'][number]): Source;
  abortAll(reason: string): void;
  dispose(): void;
}

export function createSourceProxySet(endpoint: RpcEndpoint): SourceProxySet {
  let nextId = 1;
  const auths = new Map<number, AuthChannel>();
  const sessions = new Map<
    number,
    {
      credentials(): Promise<Credentials | null>;
      log(l: LogLevel, m: string): void;
    }
  >();
  const streams = new Map<number, StreamState>();

  const push = (pullId: number, msg: Inbox) => {
    const s = streams.get(pullId);
    if (!s) return;
    s.inbox.push(msg);
    s.wake?.();
    s.wake = null;
  };

  const offNotify = endpoint.onNotify((raw) => {
    const m = raw as {
      kind: string;
      pullId?: number;
      batch?: WireBatch;
      refs?: ExternalRef[];
      error?: string;
      code?: unknown;
    };
    if (m.kind === 'src-batch')
      push(m.pullId!, { kind: 'batch', batch: m.batch! });
    else if (m.kind === 'src-refs')
      push(m.pullId!, { kind: 'refs', refs: m.refs! });
    else if (m.kind === 'src-done') push(m.pullId!, { kind: 'done' });
    else if (m.kind === 'src-error')
      push(m.pullId!, {
        kind: 'error',
        error: m.error ?? 'source error',
        // Never trust the child's value shape — sourceErrorCode narrows to
        // the two known codes and drops anything else.
        code: sourceErrorCode({ code: m.code }),
      });
  });

  /** Shared demand-driven stream loop for pull (batches) and reconcile (refs). */
  async function* stream(
    openMethod: 'pull-open' | 'reconcile-open',
    openArgs: unknown[],
    session: Session,
    pullId: number,
  ): AsyncGenerator<Inbox> {
    const state: StreamState = { inbox: [], wake: null };
    streams.set(pullId, state);
    sessions.set(pullId, {
      credentials: () => session.credentials(),
      log: (l, m) => session.log(l, m),
    });
    const onAbort = () => {
      endpoint.post({ kind: 'src-abort', pullId });
      state.wake?.();
      state.wake = null;
      // If abort lands exactly when the consumer's for-await body checks
      // the signal in-body and stops pulling without ever calling
      // it.return() (a manual [Symbol.asyncIterator]() consumer, not a
      // `for await` loop), the generator stays suspended at `yield`
      // forever and `finally` below never runs. Do the same cleanup here
      // too — a double-delete/double-removeEventListener in `finally` (when
      // it DOES run) is harmless.
      streams.delete(pullId);
      sessions.delete(pullId);
      session.signal.removeEventListener('abort', onAbort);
    };
    session.signal.addEventListener('abort', onAbort, { once: true });
    try {
      await endpoint.call('source', openMethod, [pullId, ...openArgs]);
      for (;;) {
        if (session.signal.aborted) return;
        endpoint.post({ kind: 'src-next', pullId });
        while (state.inbox.length === 0) {
          if (session.signal.aborted) return;
          // eslint-disable-next-line no-await-in-loop
          await new Promise<void>((r) => {
            state.wake = r;
          });
        }
        const msg = state.inbox.shift()!;
        if (msg.kind === 'done') return;
        if (msg.kind === 'error') {
          // Rehydrate with the wire-carried taxonomy code: the engine keys
          // off the `code` property, so a proxied source's auth failure
          // classifies exactly like a bundled one's SourceAuthError.
          const err = new Error(msg.error) as Error & {
            code?: SourceErrorCode;
          };
          if (msg.code) err.code = msg.code;
          throw err;
        }
        yield msg;
      }
    } finally {
      streams.delete(pullId);
      sessions.delete(pullId);
      session.signal.removeEventListener('abort', onAbort);
    }
  }

  return {
    async handleCall(ns, method, args) {
      if (ns === 'auth') {
        const [id, ...rest] = args as [number, ...unknown[]];
        const auth = auths.get(id);
        if (!auth) throw new Error('no active connect flow for this call');
        if (!AUTH_VERBS.has(method))
          throw new Error(`unknown auth verb ${method}`);
        if (method === 'pickFolders') {
          // Not a plain forward: rebuild a real FolderPickerSpec whose tree
          // callbacks call BACK into the child (symmetric transport — these
          // main→child calls run while the child's connect() is suspended).
          const [wire] = rest as [WirePickerSpec];
          const treeCall = <T>(verb: string, a: unknown[]) =>
            endpoint.call('source', verb, [id, ...a]) as Promise<T>;
          const spec: FolderPickerSpec = {
            modes: wire.modes,
            multiSelect: wire.multiSelect,
            roots: (modeKey) =>
              treeCall<FolderNode[]>('picker-roots', [modeKey]),
            children: (nodeId) =>
              treeCall<FolderNode[]>('picker-children', [nodeId]),
          };
          if (wire.hasCount) {
            spec.count = (nodeId) =>
              treeCall<FolderCount | null>('picker-count', [nodeId]);
          }
          return auth.pickFolders(spec);
        }
        const verb = (
          auth as unknown as Record<string, (...a: unknown[]) => unknown>
        )[method];
        return verb.call(auth, ...rest);
      }
      if (ns === 'session') {
        const [id, ...rest] = args as [number, ...unknown[]];
        const session = sessions.get(id);
        if (!session) throw new Error('no active session for this call');
        if (method === 'credentials') return session.credentials();
        if (method === 'log') {
          session.log(rest[0] as LogLevel, String(rest[1]));
          return undefined;
        }
        throw new Error(`unknown session verb ${method}`);
      }
      throw new Error(`unknown namespace ${ns}`);
    },

    makeSource(entry) {
      const { descriptor } = entry;
      const source: Source<unknown, DocumentInput> = {
        descriptor,
        async connect(auth) {
          const id = nextId;
          nextId += 1;
          auths.set(id, auth);
          try {
            return (await endpoint.call('source', 'connect', [
              id,
              descriptor.id,
            ])) as {
              identifier: string;
              config?: Record<string, unknown>;
            };
          } finally {
            auths.delete(id);
          }
        },
        async *pull(session, cursor) {
          const pullId = nextId;
          nextId += 1;
          for await (const msg of stream(
            'pull-open',
            [descriptor.id, session.account, cursor],
            session,
            pullId,
          )) {
            if (msg.kind === 'batch')
              yield msg.batch as unknown as Batch<unknown, DocumentInput>;
          }
        },
        toDocument(item) {
          return item; // child already mapped through the real toDocument
        },
      };
      if (entry.hasFetchBytes) {
        source.fetchBytes = async (session: Session, doc: Document) => {
          const id = nextId;
          nextId += 1;
          sessions.set(id, {
            credentials: () => session.credentials(),
            log: (l, m) => session.log(l, m),
          });
          try {
            const v = await endpoint.call('source', 'fetch-bytes', [
              id,
              descriptor.id,
              session.account,
              doc,
            ]);
            return v == null ? null : (v as Uint8Array);
          } finally {
            sessions.delete(id);
          }
        };
      }
      if (entry.hasReconcile) {
        source.reconcile = async function* reconcile(session: Session) {
          const pullId = nextId;
          nextId += 1;
          for await (const msg of stream(
            'reconcile-open',
            [descriptor.id, session.account],
            session,
            pullId,
          )) {
            if (msg.kind === 'refs') yield msg.refs;
          }
        };
      }
      return source as Source;
    },

    abortAll(reason) {
      streams.forEach((_s, pullId) =>
        push(pullId, { kind: 'error', error: reason }),
      );
      auths.clear();
    },

    dispose() {
      offNotify();
    },
  };
}
