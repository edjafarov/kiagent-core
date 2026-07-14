import type {
  AuthChannel,
  Credentials,
  FolderCount,
  FolderNode,
  FolderPickerSpec,
} from '@shared/contracts';
import type { ConnectEvent } from '@shared/ipc';

import { runAccount } from '../core/boot';
import type { CorePlatform } from '../core/boot';
import { newId } from '../core/ids';
import type { OAuthProfile } from './oauth-window';
import { runOAuthLoopback } from './oauth-window';

/**
 * Bridges the Source.connect() AuthChannel to the renderer's AddSource
 * wizard: qr/prompt/status ride push:connect events; OAuth opens the system
 * browser main-side. One flow at a time per flowId.
 */
export function createConnectBroker(
  platform: CorePlatform,
  send: (event: ConnectEvent) => void,
) {
  const oauthProfiles = new Map<string, OAuthProfile>();
  // flowId carried per prompt (mirroring pickers) so cancel/settle can sweep
  // a flow's own prompts; reject is what makes a cancelled flow's awaited
  // prompt throw inside source.connect().
  const pendingPrompts = new Map<
    string,
    {
      flowId: string;
      resolve: (answers: Record<string, unknown>) => void;
      reject: (err: Error) => void;
    }
  >();
  // An open pickFolders per requestId: the spec's tree callbacks service the
  // renderer's accounts:picker-* invokes; resolve/reject settle the source's
  // awaited pickFolders. flowId lets a settling flow sweep its own pickers.
  const pendingPickers = new Map<
    string,
    {
      flowId: string;
      spec: FolderPickerSpec;
      resolve: (nodes: FolderNode[]) => void;
      reject: (err: Error) => void;
    }
  >();
  // One entry per UNSETTLED flow, created in start() and removed in its
  // finally. `cancelled` is the flag the flow block checks before runAccount
  // — the only cover for a cancel landing while connect() is mid-flight
  // inside the source (post-answer validation, QR pairing) with no
  // broker-held promise to reject. `abort` closes the flow's OAuth window.
  const flows = new Map<
    string,
    { cancelled: boolean; abort: AbortController }
  >();

  /** Reject-and-forget every pending prompt/picker belonging to `flowId`. */
  function sweepFlow(flowId: string, reason: string): void {
    for (const map of [pendingPrompts, pendingPickers] as const) {
      for (const [requestId, entry] of map) {
        if (entry.flowId === flowId) {
          map.delete(requestId);
          entry.reject(new Error(reason));
        }
      }
    }
  }

  function picker(requestId: string) {
    const entry = pendingPickers.get(requestId);
    if (!entry) throw new Error(`unknown picker request: ${requestId}`);
    return entry;
  }

  return {
    registerOAuthProfile(sourceId: string, profile: OAuthProfile): void {
      oauthProfiles.set(sourceId, profile);
    },

    /** Removal counterpart for extension-contributed oauth sources — called
     *  on deactivate/uninstall so a stale profile never outlives its source
     *  registration. */
    unregisterOAuthProfile(sourceId: string): void {
      oauthProfiles.delete(sourceId);
    },

    /** Kick off an interactive connect; resolves immediately with the flowId. */
    start(sourceId: string): { flowId: string } {
      const flowId = newId<'flow'>();
      const source = platform.sources.get(sourceId);
      if (!source) {
        send({ flowId, kind: 'error', msg: `unknown source: ${sourceId}` });
        return { flowId };
      }
      const flow = { cancelled: false, abort: new AbortController() };
      flows.set(flowId, flow);
      const auth: AuthChannel = {
        async oauth(scopes: string[]): Promise<Credentials> {
          const profile = oauthProfiles.get(sourceId);
          if (!profile)
            throw new Error(`no OAuth profile registered for ${sourceId}`);
          send({ flowId, kind: 'status', msg: 'Waiting for sign-in…' });
          const callbackUrl = await runOAuthLoopback(
            profile.authUrl(scopes, profile.redirectUri),
            profile.redirectUri,
            flow.abort.signal,
          );
          return profile.exchange(callbackUrl, profile.redirectUri);
        },
        showQr(qr: string): void {
          send({ flowId, kind: 'qr', qr });
        },
        async prompt(schema: unknown): Promise<Record<string, unknown>> {
          const requestId = newId<'prompt'>();
          const answers = new Promise<Record<string, unknown>>(
            (resolve, reject) => {
              pendingPrompts.set(requestId, { flowId, resolve, reject });
            },
          );
          // Same guard as pickers below: the cancel/settle sweep may reject
          // a prompt the flow already abandoned — keep that from surfacing
          // as an unhandled rejection. The real awaiter (the source's
          // connect(), possibly across the extension-child RPC) still sees
          // the rejection.
          answers.catch(() => {});
          send({ flowId, kind: 'prompt', requestId, schema });
          return answers;
        },
        status(msg: string): void {
          send({ flowId, kind: 'status', msg });
        },
        pickFolders(spec: FolderPickerSpec): Promise<FolderNode[]> {
          const requestId = newId<'picker'>();
          const nodes = new Promise<FolderNode[]>((resolve, reject) => {
            pendingPickers.set(requestId, { flowId, spec, resolve, reject });
          });
          // The settle-time sweep may reject a picker the flow already
          // abandoned (connect() threw without awaiting it) — keep that from
          // surfacing as an unhandled rejection. The real awaiter, when there
          // is one, still sees the rejection.
          nodes.catch(() => {});
          send({
            flowId,
            kind: 'folder-picker',
            requestId,
            multiSelect: !!spec.multiSelect,
            modes: spec.modes,
          });
          return nodes;
        },
      };

      void (async () => {
        try {
          const account = await platform.engine.connect(source, auth);
          // A cancel that landed while connect() was mid-flight INSIDE the
          // source (post-answer credential validation, QR pairing) had no
          // broker-held promise to reject — connect() completed and
          // persisted the account anyway. Remove it instead of starting it:
          // a cancelled wizard must not leave a surprise account syncing.
          if (flow.cancelled) {
            await platform.engine.remove(account.id);
            send({ flowId, kind: 'error', msg: 'connect flow cancelled' });
            return;
          }
          runAccount(platform, account);
          send({ flowId, kind: 'done', account });
        } catch (err) {
          send({
            flowId,
            kind: 'error',
            msg: String(err instanceof Error ? err.message : err),
          });
        } finally {
          flows.delete(flowId);
          // The flow settled — none of its prompts or pickers can ever be
          // answered again; an unanswered prompt would otherwise pin the
          // suspended connect() frame (and its extension-child counterpart)
          // until app quit.
          sweepFlow(flowId, 'connect flow ended');
        }
      })();

      return { flowId };
    },

    /** Cancel an in-flight flow. No-op for unknown/settled flowIds — the
     *  renderer's unmount cleanup races flows that settled a beat earlier. */
    cancel(flowId: string): void {
      const flow = flows.get(flowId);
      if (!flow) return;
      flow.cancelled = true;
      // Close the flow's OAuth window (if one is open): its 'closed' handler
      // rejects the pending auth.oauth, so connect() throws and the flow
      // settles through its normal error path.
      flow.abort.abort();
      // Reject any broker-held waits so a flow blocked on user input settles
      // NOW rather than on app quit.
      sweepFlow(flowId, 'connect flow cancelled');
    },

    answer(requestId: string, answers: Record<string, unknown>): void {
      pendingPrompts.get(requestId)?.resolve(answers);
      pendingPrompts.delete(requestId);
    },

    // ── folder-picker tree service (renderer → the flow's FolderPickerSpec) ──

    pickerRoots(requestId: string, mode: string): Promise<FolderNode[]> {
      return picker(requestId).spec.roots(mode);
    },

    pickerChildren(requestId: string, id: string): Promise<FolderNode[]> {
      return picker(requestId).spec.children(id);
    },

    pickerCount(requestId: string, id: string): Promise<FolderCount | null> {
      const { spec } = picker(requestId);
      if (!spec.count) return Promise.resolve(null);
      return spec.count(id);
    },

    pickerConfirm(requestId: string, nodes: FolderNode[]): void {
      const entry = picker(requestId);
      pendingPickers.delete(requestId);
      entry.resolve(nodes);
    },

    pickerCancel(requestId: string): void {
      const entry = picker(requestId);
      pendingPickers.delete(requestId);
      entry.reject(new Error('folder selection cancelled'));
    },
  };
}

export type ConnectBroker = ReturnType<typeof createConnectBroker>;
