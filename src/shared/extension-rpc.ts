/**
 * Wire protocol between the main process and an extension host child
 * (utilityProcess in prod, child_process.fork in tests). Shared by both
 * sides; contracts.ts stays type-only, so the runtime version constant
 * lives here.
 *
 * Direction of `call`: host-surface calls originate child→main (ns = a Cap,
 * 'base', or the 'auth'/'session' callback namespaces); source/tool
 * invocations originate main→child (ns 'source' | 'tool'). Replies mirror
 * the call's id. Everything else is a one-way notification.
 */
import type {
  Cap,
  DocumentInput,
  ExternalRef,
  PullPhase,
  SourceDescriptor,
} from './contracts';

export const PLATFORM_API_VERSION = '1.0.0';

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
  }>;
  tools: ToolDescriptor[];
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
      ns: 'source' | 'tool';
      method: string;
      args: unknown[];
    }
  | { kind: 'reply'; id: number; ok: boolean; value?: unknown; error?: string }
  | { kind: 'event'; name: string; payload: unknown }
  | { kind: 'src-next'; pullId: number }
  | { kind: 'src-abort'; pullId: number }
  | { kind: 'deactivate' };

export type ChildToMain =
  | { kind: 'ready' }
  | { kind: 'activated'; contributions: Contributions }
  | { kind: 'errored'; error: string }
  | { kind: 'call'; id: number; ns: string; method: string; args: unknown[] }
  | { kind: 'reply'; id: number; ok: boolean; value?: unknown; error?: string }
  | { kind: 'src-batch'; pullId: number; batch: WireBatch }
  | { kind: 'src-refs'; pullId: number; refs: ExternalRef[] }
  | { kind: 'src-done'; pullId: number }
  | { kind: 'src-error'; pullId: number; error: string };
