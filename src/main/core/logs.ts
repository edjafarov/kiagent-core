import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';

import type { LogLevel, LogRecord, LogStore } from '@shared/contracts';

import type { LogSink } from './engine/engine';

const RING_MAX = 5_000;
const LEVEL_RANK: Record<LogLevel, number> = { info: 0, warn: 1, error: 2 };
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

export interface CreateLogsOptions {
  /** Rotate once the file exceeds this many bytes. Default 10 MB. */
  maxBytes?: number;
}

/**
 * ONE log sink. Every log() in the system lands here — engine, sources,
 * workers, hosts, and the MCP call audit (scope 'mcp.call'). In-memory ring
 * for the live viewer, JSONL file for export/bug reports.
 *
 * The file rotates at `maxBytes`: the previous generation moves to `.1`
 * (replacing any older `.1`) and the live file starts fresh. Real installs
 * were seen with an 800 MB `kiagent.log.jsonl`, at which point `export()`
 * hands over the whole thing — rotation keeps that bounded.
 */
export function createLogs(
  dir: string,
  createOpts: CreateLogsOptions = {},
): { store: LogStore; sink: LogSink } {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'kiagent.log.jsonl');
  const maxBytes = createOpts.maxBytes ?? DEFAULT_MAX_BYTES;
  const ring: LogRecord[] = [];
  const nudge = new EventEmitter();
  nudge.setMaxListeners(0);

  // Tracked in memory; the file is never read to decide whether to rotate —
  // it can be hundreds of MB.
  let bytes = 0;
  try {
    bytes = fs.statSync(file).size;
  } catch {
    bytes = 0;
  }

  const rotate = (): void => {
    try {
      fs.renameSync(file, `${file}.1`);
    } catch {
      // Best-effort: a missing file (nothing written yet) or a locked
      // rename must not take the process down.
    }
    // Reset even when the rename failed, deliberately: it is the backoff.
    // Otherwise every append past maxBytes would retry the rename while
    // (e.g. on Windows) something still holds the file open.
    bytes = 0;
  };

  // A pre-existing oversized file rotates immediately, before the first append.
  if (bytes > maxBytes) rotate();

  const sink: LogSink = {
    log(scope, level, msg, fields) {
      const rec: LogRecord = {
        ts: new Date().toISOString(),
        level,
        scope,
        msg,
        fields,
      };
      ring.push(rec);
      if (ring.length > RING_MAX) ring.splice(0, ring.length - RING_MAX);
      try {
        const line = `${JSON.stringify(rec)}\n`;
        fs.appendFileSync(file, line);
        bytes += Buffer.byteLength(line);
        if (bytes > maxBytes) rotate();
      } catch {
        // Disk full, permissions, a read-only volume — the ring buffer and
        // live viewer must keep working even if the file write fails.
      }
      nudge.emit('rec', rec);
    },
  };

  const store: LogStore = {
    tail(opts) {
      const match = (r: LogRecord): boolean =>
        (!opts?.scope || r.scope.startsWith(opts.scope)) &&
        (!opts?.level || LEVEL_RANK[r.level] >= LEVEL_RANK[opts.level]);
      return {
        [Symbol.asyncIterator]() {
          let sent = false;
          const queue: LogRecord[] = [];
          const onRec = (r: LogRecord) => {
            if (match(r)) queue.push(r);
            nudge.emit('drain');
          };
          nudge.on('rec', onRec);
          return {
            async next(): Promise<IteratorResult<LogRecord[]>> {
              if (!sent) {
                sent = true;
                return { done: false, value: ring.filter(match) };
              }
              for (;;) {
                if (queue.length)
                  return { done: false, value: queue.splice(0) };
                await new Promise<void>((resolve) => {
                  nudge.once('drain', resolve);
                });
              }
            },
            async return(): Promise<IteratorResult<LogRecord[]>> {
              nudge.off('rec', onRec);
              return { done: true, value: undefined };
            },
          };
        },
      };
    },
    async export() {
      return file;
    },
  };

  return { store, sink };
}
