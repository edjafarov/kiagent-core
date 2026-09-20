/**
 * B1 (host-owned renderer eventing) — the `ext:invoke` dispatch boundary.
 * Deliberately its own module: main.ts wires real Electron (ipcMain,
 * BrowserWindow) and cannot run under jest, but this function is exactly
 * what the full-bridge error-fidelity gate needs to drive directly, with a
 * fake `event`/`isTrustedSender`/`platform`.
 *
 * The one governing rule: this function NEVER throws and its returned
 * promise NEVER rejects. `ipcMain.handle` serializes only `Error.message`
 * on a rejection (electron.d.ts, around the handle() doc comment) — every
 * outcome here is a discriminated `ExtInvokeEnvelope` instead, so `code`
 * and `message` both survive the IPC round trip intact.
 */
import type { ExtInvokeEnvelope, ExtInvokeRequest } from '@shared/ipc';

import type { ExtensionPlatform } from './extension-platform';

export interface ExtInvokeDeps {
  /** Same predicate `attention:list`/`attention:act` are gated by
   *  (`ipc-sender.ts`'s `createTrustedRendererPredicate`) — registered
   *  webContents, its current main frame, the approved renderer document.
   *  `ext:invoke` reuses it unchanged rather than re-implementing: it is
   *  already the strictest form of every sender check this repo has (see
   *  the product overlay's four now-superseded per-extension copies,
   *  expenses/people/deadlines/documents, which this predicate is at
   *  least as strict as by construction — same four checks). */
  isTrustedSender(event: unknown): boolean;
  platform: Pick<ExtensionPlatform, 'callUi'>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function parseExtInvokeRequest(
  req: unknown,
): { ok: true; value: ExtInvokeRequest } | { ok: false; message: string } {
  if (!isRecord(req))
    return { ok: false, message: 'ext:invoke request must be an object' };
  const { extensionId, name } = req;
  if (typeof extensionId !== 'string' || extensionId.length === 0)
    return {
      ok: false,
      message: 'ext:invoke request.extensionId must be a non-empty string',
    };
  if (typeof name !== 'string' || name.length === 0)
    return {
      ok: false,
      message: 'ext:invoke request.name must be a non-empty string',
    };
  // `payload` is intentionally unchecked — its shape is between the
  // renderer and the extension's own registered handler, never the host's
  // business.
  return { ok: true, value: { extensionId, name, payload: req.payload } };
}

/** Builds the `(event, req) => Promise<ExtInvokeEnvelope>` handler main.ts
 *  registers for the `ext:invoke` channel (over the SAME derived-allowlist
 *  loop every other invoke channel goes through — see
 *  ipc-handler-coverage.test.ts). Kept separate from `guardIpcHandler`
 *  (main.ts's generic per-channel gate, which THROWS an untrusted sender
 *  rather than resolving) — `ext:invoke` needs its own never-reject
 *  discipline even for a failed sender check, so this channel's entry in
 *  that loop calls this function instead of that shared gate. */
export function createExtInvokeHandler(
  deps: ExtInvokeDeps,
): (event: unknown, req: unknown) => Promise<ExtInvokeEnvelope> {
  return async (event, req) => {
    try {
      if (!deps.isTrustedSender(event)) {
        return {
          ok: false,
          code: 'EXT_UNTRUSTED_SENDER',
          message: 'untrusted renderer',
        };
      }
      const parsed = parseExtInvokeRequest(req);
      if (!parsed.ok) {
        return {
          ok: false,
          code: 'EXT_MALFORMED_REQUEST',
          message: parsed.message,
        };
      }
      const envelope = await deps.platform.callUi(
        parsed.value.extensionId,
        parsed.value.name,
        parsed.value.payload,
      );
      try {
        // `ipcMain.handle`'s return value crosses Electron's own structured
        // clone, same as any other IPC payload. For an IN-PROCESS extension
        // (createInMemoryHostPair, transport.ts) nothing upstream of this
        // point ever serializes the envelope — a handler that resolves a
        // live function/Promise/Symbol/Proxy reaches here completely
        // unchanged. Cloning it HERE, synchronously, turns that case into an
        // ordinary EXT_HANDLER_FAILED envelope instead of letting Electron's
        // own clone fail deep inside `ipcMain.handle`, AFTER this function
        // has already returned — which logs "An object could not be cloned"
        // and leaves the renderer's `invoke()` promise unsettled forever.
        return structuredClone(envelope);
      } catch (cloneError) {
        return {
          ok: false,
          code: 'EXT_HANDLER_FAILED',
          message: `ui handler result is not structured-clone-safe: ${
            cloneError instanceof Error
              ? cloneError.message
              : String(cloneError)
          }`,
        };
      }
    } catch (error) {
      // Belt-and-suspenders: `platform.callUi` is documented to never
      // throw/reject, but this handler's own governing rule (never reject
      // the IPC call) must hold even if that contract is ever violated by
      // a future change.
      return {
        ok: false,
        code: 'EXT_HANDLER_FAILED',
        message: error instanceof Error ? error.message : String(error),
      };
    }
  };
}
