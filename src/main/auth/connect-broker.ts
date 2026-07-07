import type { BrowserWindow } from 'electron';

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
import { runOAuthWindow } from './oauth-window';

/**
 * Bridges the Source.connect() AuthChannel to the renderer's AddSource
 * wizard: qr/prompt/status ride push:connect events; OAuth opens a window
 * main-side. One flow at a time per flowId.
 */
export function createConnectBroker(
  platform: CorePlatform,
  send: (event: ConnectEvent) => void,
  getParentWindow: () => BrowserWindow | undefined,
) {
  const oauthProfiles = new Map<string, OAuthProfile>();
  const pendingPrompts = new Map<
    string,
    (answers: Record<string, unknown>) => void
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
      const auth: AuthChannel = {
        async oauth(scopes: string[]): Promise<Credentials> {
          const profile = oauthProfiles.get(sourceId);
          if (!profile) throw new Error(`no OAuth profile registered for ${sourceId}`);
          send({ flowId, kind: 'status', msg: 'Waiting for sign-in…' });
          const callbackUrl = await runOAuthWindow(
            profile.authUrl(scopes, profile.redirectUri),
            profile.redirectUri,
            getParentWindow(),
          );
          return profile.exchange(callbackUrl, profile.redirectUri);
        },
        showQr(qr: string): void {
          send({ flowId, kind: 'qr', qr });
        },
        async prompt(schema: unknown): Promise<Record<string, unknown>> {
          const requestId = newId<'prompt'>();
          const answers = new Promise<Record<string, unknown>>((resolve) => {
            pendingPrompts.set(requestId, resolve);
          });
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
          runAccount(platform, account);
          send({ flowId, kind: 'done', account });
        } catch (err) {
          send({
            flowId,
            kind: 'error',
            msg: String(err instanceof Error ? err.message : err),
          });
        } finally {
          // The flow settled — none of its pickers can ever be answered again.
          // (Prompts keep their existing keep-until-answered semantics.)
          for (const [requestId, entry] of pendingPickers) {
            if (entry.flowId === flowId) {
              pendingPickers.delete(requestId);
              entry.reject(new Error('connect flow ended'));
            }
          }
        }
      })();

      return { flowId };
    },

    answer(requestId: string, answers: Record<string, unknown>): void {
      pendingPrompts.get(requestId)?.(answers);
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
