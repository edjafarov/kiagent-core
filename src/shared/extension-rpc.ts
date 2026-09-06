/**
 * Wire protocol between the main process and an extension host child
 * (utilityProcess in prod, child_process.fork in tests). Shared by both
 * sides; contracts.ts stays type-only, so the runtime version constant
 * lives here.
 *
 * Direction of `call`: host-surface calls originate child→main (ns = a Cap,
 * 'base', or the 'auth'/'session' callback namespaces); source/tool/send
 * invocations originate main→child (ns 'source' | 'tool' | 'send'). Replies
 * mirror the call's id. Everything else is a one-way notification.
 */
import type {
  Cap,
  DocumentInput,
  EventMeta,
  ExternalRef,
  PullPhase,
  SourceDescriptor,
} from './contracts';
import type { SourceErrorCode } from './source-errors';

export const PLATFORM_API_VERSION = '2.0.0';

/** A Batch after the child mapped items through the source's toDocument —
 *  the generic Item type never crosses the wire. */
export interface WireBatch {
  phase: PullPhase;
  items: DocumentInput[];
  deletions?: ExternalRef[];
  cursor: unknown;
  estimateTotal?: number;
}

export interface ToolDescriptor {
  name: string;
  description: string;
  inputSchema: unknown;
  tier?: 'standard' | 'powerful';
}

/** Serializable summary of what activate() returned; the callable objects
 *  stay in the child, main registers proxies. */
export interface Contributions {
  sources: Array<{
    descriptor: SourceDescriptor;
    hasFetchBytes: boolean;
    hasReconcile: boolean;
    /** A4: `source-proxy.makeSource` attaches optional methods ONLY behind
     *  these flags (`source-proxy.ts:261` fetchBytes, `:282` reconcile), so a
     *  capability absent here can never be true on a proxied source no matter
     *  what the connector implements.
     *
     *  NOT the same field as `SourceDescriptor.hasReauthenticate` (C-9),
     *  which is optional, renderer-facing, and stamped by Task 7 in
     *  `src/main/core/boot.ts:118`. This one is required and rides the
     *  extension-RPC wire only. */
    hasManageFolders: boolean;
    hasReauthenticate: boolean;
  }>;
  tools: ToolDescriptor[];
  /** Source ids this extension provides a Sender for (declared AND returned
   *  from activate) — [] when none. */
  senders: string[];
}

export interface ExtensionBootstrap {
  kind: 'bootstrap';
  v: 1;
  extensionId: string;
  entryAbsPath: string;
  dataDir: string;
  caps: Cap[];
}

export type MainToChild =
  | ExtensionBootstrap
  | {
      kind: 'call';
      id: number;
      ns: 'source' | 'tool' | 'send';
      method: string;
      args: unknown[];
    }
  | {
      kind: 'reply';
      id: number;
      ok: boolean;
      value?: unknown;
      error?: string;
      /** Same taxonomy code the `src-error` notify carries (see below), on
       *  the call/reply leg — a rejected main-side handler (e.g. a
       *  session.credentials() whose refresher threw SourceAuthError) keeps
       *  its classification across the boundary. Both directions declare it:
       *  ONE endpoint implementation (transport.ts) serves both. */
      code?: SourceErrorCode;
      /** The rejecting error's `Error.name` (e.g. 'LaneClosedError',
       *  'ModelChangedError') — class identity does not survive the fork,
       *  so a caller on the other side discriminates by `name`, never
       *  `instanceof` (see e.g. `ModelChangedError`'s own doc comment in
       *  contracts.ts). Only set when the rejection was a real `Error`. */
      errorName?: string;
      /** A small allow-listed set of the rejecting error's own enumerable
       *  fields (transport.ts's `ERROR_FIELD_ALLOWLIST`), reattached onto
       *  the reconstructed `Error` on the receiving end — e.g.
       *  `ModelChangedError`'s `{ expected, actual, modelId, source }`.
       *  `LaneClosedError` carries no extra fields, so this stays absent
       *  for it. Plain data only: no class instances, no functions. */
      errorFields?: Record<string, unknown>;
    }
  | { kind: 'event'; name: string; payload: unknown; meta: EventMeta }
  | { kind: 'src-next'; pullId: number }
  | { kind: 'src-abort'; pullId: number }
  | { kind: 'deactivate' };

export type ChildToMain =
  | { kind: 'ready' }
  | { kind: 'activated'; contributions: Contributions }
  | { kind: 'errored'; error: string }
  | { kind: 'call'; id: number; ns: string; method: string; args: unknown[] }
  | {
      kind: 'reply';
      id: number;
      ok: boolean;
      value?: unknown;
      error?: string;
      /** See MainToChild's reply variant — symmetric by construction. */
      code?: SourceErrorCode;
      /** See MainToChild's reply variant — symmetric by construction. */
      errorName?: string;
      /** See MainToChild's reply variant — symmetric by construction. */
      errorFields?: Record<string, unknown>;
    }
  | { kind: 'src-batch'; pullId: number; batch: WireBatch }
  | { kind: 'src-refs'; pullId: number; refs: ExternalRef[] }
  | { kind: 'src-done'; pullId: number }
  /** `code` carries the source-error taxonomy (see source-errors.ts) across
   *  the process boundary — main rehydrates a plain Error with the same
   *  `code` property so proxied sources classify exactly like bundled ones
   *  (e.g. 'auth' → status 'needsReauth', no retries). Optional and additive:
   *  older children simply never set it. */
  | {
      kind: 'src-error';
      pullId: number;
      error: string;
      code?: SourceErrorCode;
    };
