/**
 * THE runtime gate() (concept/model.ts §5): every host call an extension
 * makes lands here BEFORE any real capability code runs. Greenfield caps
 * map 1:1 to host namespaces, so the permission table is this lookup —
 * no per-method map like the legacy 38-method HOST_SURFACE needed.
 */
import type { Cap, LogLevel } from '@shared/contracts';
import type { LogSink } from '@main/core/engine/engine';

import type { Surfaces } from './host-surfaces';

const NS_CAP: Record<string, Cap> = {
  query: 'query',
  net: 'net',
  files: 'files',
  db: 'db',
  ui: 'ui',
  commands: 'commands',
  inference: 'inference',
  events: 'events',
};

export function createHostRouter(opts: {
  extensionId: string;
  granted: ReadonlySet<Cap>;
  surfaces: Surfaces;
  logSink: LogSink;
}): { dispatch(ns: string, method: string, args: unknown[]): Promise<unknown> } {
  const scope = `extension:${opts.extensionId}`;
  return {
    async dispatch(ns, method, args) {
      if (ns === 'base') {
        if (method === 'log') {
          opts.logSink.log(scope, args[0] as LogLevel, String(args[1]));
          return undefined;
        }
        throw new Error(`unknown method base.${method}`);
      }
      // Namespace resolution: safe lookup only (no prototype chain walk).
      if (!Object.prototype.hasOwnProperty.call(NS_CAP, ns)) {
        throw new Error(`unknown namespace ${ns}`);
      }
      const cap = NS_CAP[ns];
      // Grant check: precedes method existence (controller adjudication).
      if (!opts.granted.has(cap)) {
        opts.logSink.log(scope, 'warn', 'permission-violation', { ns, method });
        throw new Error(`CAP_DENIED: extension was not granted the '${cap}' capability`);
      }
      // Method existence check: only after grant passes. Own-property +
      // typeof guards (no prototype-chain lookup) so a GRANTED namespace
      // can't be probed with e.g. 'constructor'/'hasOwnProperty' to reach a
      // non-function prototype member and TypeError instead of cleanly
      // failing 'unknown method'.
      const nsSurface = opts.surfaces[ns];
      const fn =
        nsSurface && Object.prototype.hasOwnProperty.call(nsSurface, method)
          ? nsSurface[method]
          : undefined;
      if (typeof fn !== 'function') throw new Error(`unknown method ${ns}.${method}`);
      return fn(...args);
    },
  };
}
