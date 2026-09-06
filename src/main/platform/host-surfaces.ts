/**
 * The REAL capability implementations behind HostFor<G> namespaces — all
 * main-side; the child only holds proxies. One instance per extension per
 * host incarnation. files/commands are declared-but-rejected in this build
 * (spec §3.7): the cap validates and consents, but calls fail loudly.
 */
import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';

import type { LaneState, LogLevel, Query } from '@shared/contracts';

import type { LogSink } from '@main/core/engine/engine';

import { assertAllowedSql } from './db-guard';
import { createNetFetch } from './net-guard';

export class CapError extends Error {}

export interface EventBus {
  emit(from: string, event: string, payload: unknown): void;
  subscribe(
    extensionId: string,
    event: string,
    deliver: (payload: unknown) => void,
  ): () => void;
}

/** Delivery includes the emitter itself when subscribed — self-delivery is
 *  part of the contract. `logSink` is optional so every existing caller
 *  (tests included) keeps compiling unchanged; production wires the real
 *  one so a dead subscriber's failure is reported, not silent. */
export function createEventBus(logSink?: LogSink): EventBus {
  const subs = new Map<string, Set<(payload: unknown) => void>>();
  return {
    emit(_from, event, payload) {
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
          cb(payload);
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

export function buildSurfaces(deps: SurfaceDeps): {
  surfaces: Surfaces;
  close(): void;
} {
  const netFetch = createNetFetch();
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
      countBy: (q) => deps.query.countBy((q ?? {}) as never),
      accounts: () => deps.query.accounts(),
    },
    net: {
      // Public internet destinations only — see net-guard.ts for why the
      // scheme check alone was not a boundary.
      fetch: (url, init) => netFetch(url, init),
    },
    db: {
      // Every statement is policed first — see db-guard.ts for why "your own
      // database" was not, on its own, a boundary.
      async exec(sql, params) {
        assertAllowedSql(String(sql));
        const d = openDb();
        const p = (params ?? []) as unknown[];
        if (p.length === 0) d.exec(String(sql));
        else d.prepare(String(sql)).run(...p);
      },
      async query(sql, params) {
        assertAllowedSql(String(sql));
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
