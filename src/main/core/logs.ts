import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';

import type { LogLevel, LogRecord, LogStore } from '@shared/contracts';

import type { LogSink } from './engine/engine';

const RING_MAX = 5_000;
const LEVEL_RANK: Record<LogLevel, number> = { info: 0, warn: 1, error: 2 };

/**
 * ONE log sink. Every log() in the system lands here — engine, sources,
 * workers, hosts, and the MCP call audit (scope 'mcp.call'). In-memory ring
 * for the live viewer, JSONL file for export/bug reports.
 */
export function createLogs(dir: string): { store: LogStore; sink: LogSink } {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'kiagent.log.jsonl');
  const ring: LogRecord[] = [];
  const nudge = new EventEmitter();
  nudge.setMaxListeners(0);

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
      fs.appendFile(file, `${JSON.stringify(rec)}\n`, () => {});
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
