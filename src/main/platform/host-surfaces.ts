/**
 * The REAL capability implementations behind HostFor<G> namespaces — all
 * main-side; the child only holds proxies. One instance per extension per
 * host incarnation. files/commands are declared-but-rejected in this build
 * (spec §3.7): the cap validates and consents, but calls fail loudly.
 */
import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';

import type { LogLevel, Query } from '@shared/contracts';

export class CapError extends Error {}

export interface EventBus {
  emit(from: string, event: string, payload: unknown): void;
  subscribe(
    extensionId: string,
    event: string,
    deliver: (payload: unknown) => void,
  ): () => void;
}

/** Delivery includes the emitter itself when subscribed — self-delivery is part of the contract. */
export function createEventBus(): EventBus {
  const subs = new Map<string, Set<(payload: unknown) => void>>();
  return {
    emit(_from, event, payload) {
      subs.get(event)?.forEach((cb) => cb(payload));
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
  dataDir: string;
  query: Query;
  inference: {
    complete(
      prompt: string,
      opts?: { maxTokens?: number; lane?: 'interactive' | 'background' },
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
  };
  notify(msg: string, level?: LogLevel): void;
  bus: EventBus;
  /** Ships a host event to the child (endpoint.post({kind:'event',…})). */
  deliverEvent(name: string, payload: unknown): void;
}

const unsupported = (ns: string) => () => {
  throw new CapError(
    `the '${ns}' capability is not supported in this build yet`,
  );
};

/**
 * `net.fetch` is reachable by semi-trusted third-party connector
 * extensions — a huge or malicious endpoint must not be able to buffer an
 * unbounded response in the main process. 50 MiB comfortably covers
 * ordinary API/webhook payloads.
 */
const MAX_NET_FETCH_BYTES = 50 * 1024 * 1024; // 50 MiB

/**
 * Reads `res`'s body up to `maxBytes`, throwing a descriptive error the
 * moment that's exceeded. Checked against `content-length` up front (fail
 * fast, no need to read anything), then again against the running total
 * while streaming — a `content-length` header can lie or be absent, so it
 * can't be trusted alone.
 */
async function readBoundedBody(
  res: Response,
  maxBytes: number,
): Promise<Uint8Array> {
  const limit = `${Math.floor(maxBytes / (1024 * 1024))} MiB`;
  const declared = res.headers.get('content-length');
  if (declared && Number(declared) > maxBytes) {
    throw new Error(`net.fetch: response exceeds the ${limit} limit`);
  }
  if (!res.body) {
    const buf = await res.arrayBuffer();
    if (buf.byteLength > maxBytes) {
      throw new Error(`net.fetch: response exceeds the ${limit} limit`);
    }
    return new Uint8Array(buf);
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        // Stop the transfer too — without cancel() the stream keeps
        // pulling bytes until GC even though we've already given up.
        await reader.cancel();
        throw new Error(`net.fetch: response exceeds the ${limit} limit`);
      }
      chunks.push(value);
    }
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

export function buildSurfaces(deps: SurfaceDeps): {
  surfaces: Surfaces;
  close(): void;
} {
  let db: Database.Database | null = null;
  const openDb = () => {
    if (!db) {
      fs.mkdirSync(deps.dataDir, { recursive: true });
      db = new Database(path.join(deps.dataDir, 'private.db'));
    }
    return db;
  };
  const eventSubs = new Map<string, () => void>();

  const surfaces: Surfaces = {
    query: {
      search: (q) => deps.query.search((q ?? {}) as never),
      document: (id) => deps.query.document(id as never),
      children: (id) => deps.query.children(id as never),
      byExternalId: (account, externalId, type) =>
        deps.query.byExternalId(
          account as never,
          externalId as never,
          type as never,
        ),
      count: (q) => deps.query.count((q ?? {}) as never),
      accounts: () => deps.query.accounts(),
    },
    net: {
      async fetch(url, init) {
        const u = String(url);
        if (!/^https?:\/\//.test(u))
          throw new Error('net.fetch only supports http(s) URLs');
        const i = (init ?? {}) as {
          method?: string;
          headers?: Record<string, string>;
          body?: string | Uint8Array;
        };
        const res = await fetch(u, {
          method: i.method,
          headers: i.headers,
          body: i.body,
        });
        return {
          status: res.status,
          statusText: res.statusText,
          headers: Object.fromEntries(res.headers.entries()),
          body: await readBoundedBody(res, MAX_NET_FETCH_BYTES),
        };
      },
    },
    db: {
      async exec(sql, params) {
        const d = openDb();
        const p = (params ?? []) as unknown[];
        if (p.length === 0) d.exec(String(sql));
        else d.prepare(String(sql)).run(...p);
      },
      async query(sql, params) {
        return openDb()
          .prepare(String(sql))
          .all(...((params ?? []) as unknown[]));
      },
    },
    ui: {
      notify: (msg, level) =>
        deps.notify(String(msg), level as LogLevel | undefined),
    },
    inference: {
      complete: (prompt, opts) =>
        deps.inference.complete(String(prompt), {
          ...(opts as object),
          lane: 'interactive',
        }),
      see: (image, prompt, opts) =>
        deps.inference.see(image as Uint8Array, String(prompt), {
          ...(opts as object),
          lane: 'interactive',
        }),
      read: (image, opts) =>
        deps.inference.read(image as Uint8Array, {
          ...(opts as object),
          lane: 'interactive',
        }),
    },
    events: {
      on(event) {
        const name = String(event);
        if (eventSubs.has(name)) return;
        eventSubs.set(
          name,
          deps.bus.subscribe(deps.extensionId, name, (p) =>
            deps.deliverEvent(name, p),
          ),
        );
      },
      off(event) {
        const name = String(event);
        eventSubs.get(name)?.();
        eventSubs.delete(name);
      },
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
    files: {
      list: unsupported('files'),
      read: unsupported('files'),
      write: unsupported('files'),
      move: unsupported('files'),
    },
    commands: { register: unsupported('commands') },
  };

  return {
    surfaces,
    close() {
      eventSubs.forEach((off) => off());
      eventSubs.clear();
      db?.close();
      db = null;
    },
  };
}
