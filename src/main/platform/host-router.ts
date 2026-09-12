/**
 * THE runtime gate() (concept/model.ts §5): every host call an extension
 * makes lands here BEFORE any real capability code runs. Greenfield caps
 * map 1:1 to host namespaces, so the permission table is this lookup —
 * no per-method map like the legacy 38-method HOST_SURFACE needed.
 */
import type { Cap, LogLevel } from '@shared/contracts';
import type { LogSink } from '@main/core/engine/engine';

import type { Surfaces } from './host-surfaces';
import type { RpcCallContext } from './transport';
import { HostCallInTransactionError } from './host-call-context';

/** Exported for the drift guard (cap-table-completeness.test.ts), which
 *  derives the expected key set from manifest.ts's CAPS. */
export const NS_CAP: Record<string, Cap> = {
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
}): {
  dispatch(
    ns: string,
    method: string,
    args: unknown[],
    context?: RpcCallContext,
  ): Promise<unknown>;
} {
  const scope = `extension:${opts.extensionId}`;
  return {
    async dispatch(ns, method, args, context) {
      if (context?.transactionId && ns !== 'db')
        throw new HostCallInTransactionError(ns);
      if (ns === 'db') {
        const hasContext = !!context?.transactionId;
        const isSdkBoundary = !!context?.transactionBoundary;
        const token = String(args[0]);
        const tokenOverload =
          (method === 'exec' || method === 'query') &&
          typeof args[0] === 'string' &&
          typeof args[1] === 'string';
        const batchTokenOverload =
          method === 'batch' && !Array.isArray(args[0]);
        if (
          (method === 'begin' && (!isSdkBoundary || hasContext)) ||
          (method === 'begin' && hasContext) ||
          ((method === 'commit' || method === 'rollback') &&
            (!hasContext || token !== context?.transactionId)) ||
          ((tokenOverload || batchTokenOverload) &&
            (!hasContext || token !== context?.transactionId))
        )
          throw new HostCallInTransactionError(ns);
      }
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
        throw new Error(
          `CAP_DENIED: extension was not granted the '${cap}' capability`,
        );
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
      if (typeof fn !== 'function')
        throw new Error(`unknown method ${ns}.${method}`);
      // Cancellation is a transport concern, not an extension-controlled
      // argument. Append the host-owned signal only for cancellable service
      // calls; the surface functions keep their public arity for ordinary
      // callers and never let a child forge this signal.
      if (
        ns === 'db' &&
        (method === 'begin' || method === 'commit' || method === 'rollback')
      ) {
        if (method === 'commit' || method === 'rollback')
          return fn(...args, context?.transactionId, context?.signal);
        return fn(...args, context?.signal, context?.transactionBoundary);
      }
      if (context?.signal && ns === 'db') {
        if (method === 'exec' || method === 'query') {
          const positional = [...args];
          while (positional.length < 3) positional.push(undefined);
          return fn(...positional, context.signal);
        }
        if (method === 'migrate')
          return fn(...args.slice(0, 3), context.signal);
        if (method === 'batch') {
          const positional = [...args];
          while (positional.length < 2) positional.push(undefined);
          return fn(...positional, context.signal);
        }
        return fn(...args, context.signal);
      }
      if (context?.signal && ns === 'net') return fn(...args, context.signal);
      return fn(...args);
    },
  };
}
