/**
 * The op names the `/outbox/api` loopback plane speaks — ONE list, read by
 * both of its ends: the in-app dispatcher (routes.ts) and the stdio
 * sibling's client (mcp/outbound-proxy.ts). Before this module the two sides
 * each carried their own copy, so an op added to one and not the other
 * failed as "unknown op" at runtime, in the sibling process, with nothing to
 * point at the cause.
 *
 * Deliberately its own module rather than a service.ts export: the proxy
 * imports service.ts TYPE-ONLY so the bundled senders (and their
 * nodemailer/imapflow dependencies) stay out of the sibling's runtime graph,
 * and a value import would undo that. The OutboundToolApi import below is
 * type-only for the same reason — it is erased at emit, leaving this module
 * with no runtime dependencies at all.
 */
import type { OutboundToolApi } from './service';

/** 'ping' is the port-discovery probe and has no method behind it; every
 *  other op IS an OutboundToolApi method name (guarded below). */
export const OUTBOUND_TOOL_OPS = [
  'ping',
  'draftReply',
  'draftMessage',
  'listOutbox',
  'sendDraft',
] as const;

export type OutboundToolOp = (typeof OUTBOUND_TOOL_OPS)[number];

/** Compile guards, BOTH directions — neither alone is enough, and neither
 *  restates the list (a second copy would just be one more thing to drift).
 *  The first catches a renamed or removed method (an op stops naming one);
 *  the second catches an ADDED method, which would otherwise be silently
 *  unreachable over this plane for the stdio sibling. Either one failing
 *  collapses its alias to `never` and breaks the assignment. */
type _OpsAreMethods =
  Exclude<OutboundToolOp, 'ping'> extends keyof OutboundToolApi ? true : never;
type _MethodsAreOps =
  keyof OutboundToolApi extends Exclude<OutboundToolOp, 'ping'> ? true : never;
const _opsMatchApi: [_OpsAreMethods, _MethodsAreOps] = [true, true];

/** Narrows an op name arriving off the wire. */
export function isOutboundToolOp(op: unknown): op is OutboundToolOp {
  return (OUTBOUND_TOOL_OPS as readonly unknown[]).includes(op);
}
