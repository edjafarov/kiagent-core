import type {
  Account,
  AccountId,
  AuthChannel,
  Credentials,
  FolderCount,
  FolderNode,
  FolderPickerSpec,
  FolderScopeUpdate,
  FolderSelectionChannel,
} from '@shared/contracts';
import type { ConnectEvent } from '@shared/ipc';

import { runAccount } from '../core/boot';
import type { CorePlatform } from '../core/boot';
import { newId } from '../core/ids';
import type { OAuthClientOverride, OAuthProfile } from './oauth-window';
import { runOAuthLoopback } from './oauth-window';

import { FolderScopeStaleError } from '../core/engine/flow-errors';
import type { FolderFlowStage } from '../core/engine/flow-telemetry';
import {
  folderFlowStage,
  logFolderFlowFailure,
  logScopeChanged,
} from '../core/engine/flow-telemetry';

/**
 * Bridges the Source.connect() AuthChannel to the renderer's AddSource
 * wizard: qr/prompt/status ride push:connect events; OAuth opens the system
 * browser main-side. One flow at a time per flowId.
 */
export function createConnectBroker(
  platform: CorePlatform,
  send: (event: ConnectEvent) => void,
  brokerOpts?: { cancelGraceMs?: number },
) {
  const oauthProfiles = new Map<string, OAuthProfile>();
  /** How long a CANCELLED account flow is given to settle on its own before
   *  the broker forces its terminal event and frees the account's slot
   *  (C-28.5). Generous, because the normal case is a source that notices the
   *  abort within a tick — this only ever fires for one that does not.
   *  Injectable so the watchdog is provable on real timers. */
  const cancelGraceMs = brokerOpts?.cancelGraceMs ?? 10_000;
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

  /** The narrow channel an account-scoped flow gets: `status` + `pickFolders`
   *  and nothing else. Deliberately NOT an AuthChannel — managing folders
   *  must never be able to start an OAuth flow (spec invariant 3).
   *
   *  `start()` keeps its own inline copy of pickFolders on purpose: folding
   *  the two together would rewrite the same lines Task 5 edits. Fold them in
   *  a follow-up once both have landed. */
  function makePickerChannel(flowId: string): FolderSelectionChannel {
    return {
      status(msg: string): void {
        send({ flowId, kind: 'status', msg });
      },
      pickFolders(spec: FolderPickerSpec): Promise<FolderNode[]> {
        const requestId = newId<'picker'>();
        const nodes = new Promise<FolderNode[]>((resolve, reject) => {
          pendingPickers.set(requestId, { flowId, spec, resolve, reject });
        });
        nodes.catch(() => {});
        send({
          flowId,
          kind: 'folder-picker',
          requestId,
          multiSelect: !!spec.multiSelect,
          modes: spec.modes,
          selected: spec.selected ?? [],
          purpose: spec.purpose ?? 'manage',
        });
        return nodes;
      },
    };
  }

  /** Canonical root ids, tolerant of a config that predates the migration or
   *  was hand-edited: a malformed entry is skipped, never thrown on. */
  function folderRootIds(config: Record<string, unknown>): string[] {
    const roots = (config as { folderRoots?: unknown }).folderRoots;
    if (!Array.isArray(roots)) return [];
    return roots
      .map((r) => (r as { id?: unknown } | null)?.id)
      .filter((id): id is string => typeof id === 'string');
  }

  /** Shared bookkeeping for the two ACCOUNT-scoped flows. The cancel
   *  compensation is INVERTED relative to start(): start() removes an account
   *  a late-cancelled connect created, because it did not exist a second ago.
   *  Here the account IS the user's corpus, so cancel means stop, write
   *  nothing, remove nothing. NOTHING reachable from this function may call
   *  platform.engine.remove — that is the single most important rule in this
   *  file.
   *
   *  `stage` is the flow's current observability stage (A-7); the body moves
   *  it as it progresses, and the catch refines it from the error type. */
  function runAccountFlow(
    accountId: AccountId,
    initialStage: FolderFlowStage,
    /** The terminal a FORCED cancel reports for this flow (C-28.5) — the same
     *  string the body would have produced had it noticed the abort. */
    cancelMsg: string,
    /** Returns the flow's TERMINAL event rather than sending it. Making the
     *  success terminal a return value is what guarantees one exists: a body
     *  that forgets to send does not compile. */
    body: (ctx: {
      flowId: string;
      flow: { cancelled: boolean; abort: AbortController };
      account: Account;
      stage: (next: FolderFlowStage) => void;
    }) => Promise<ConnectEvent>,
  ): { flowId: string } {
    const flowId = newId<'flow'>();
    try {
      platform.engine.claimAccountFlow(accountId, flowId);
    } catch (err) {
      // Same shape as start()'s unknown-source refusal (:95-99): a flowId
      // comes back and the failure arrives as an event, so the renderer's
      // subscribe-before-invoke buffer renders it with no new code path.
      // Nothing to release — the claim is what failed.
      send({
        flowId,
        kind: 'error',
        msg: String(err instanceof Error ? err.message : err),
      });
      return { flowId };
    }
    const flow = { cancelled: false, abort: new AbortController() };
    flows.set(flowId, flow);
    let stage = initialStage;
    let sourceId = 'unknown';

    // ── C-28.5: the guaranteed terminal ──────────────────────────────────
    // `cancel()` (`:186-198`) emits NO event of its own: it sets the flag,
    // aborts the controller and rejects broker-held promises. Every terminal a
    // flow can produce therefore comes from the body — so a `reauthenticate()`
    // / `manageFolders()` that ignores the signal, catches and swallows the
    // picker rejection, or simply hangs on a provider call produces NO
    // terminal at all. The renderer's spinner never stops and, worse, the
    // account's flow slot is held until the app quits: Reconnect and Manage
    // folders are both dead for that account, and the only remaining move on
    // the detail screen is Remove.
    let settled = false;
    let watchdog: ReturnType<typeof setTimeout> | null = null;
    /** The ONE exit. Idempotent: whichever of the body and the watchdog gets
     *  here first owns the terminal event, the flow entry, the picker sweep
     *  and the account slot — the loser is a no-op, so a zombie body that
     *  finally settles cannot send a second terminal or free a slot its
     *  successor already took (`releaseAccountFlow` is keyed by flowId, which
     *  is the second guard on the same hazard). */
    const finish = (event: ConnectEvent): void => {
      if (settled) return;
      settled = true;
      if (watchdog !== null) clearTimeout(watchdog);
      flow.abort.signal.removeEventListener('abort', armWatchdog);
      send(event);
      flows.delete(flowId);
      sweepFlow(flowId, 'connect flow ended');
      platform.engine.releaseAccountFlow(accountId, flowId);
    };
    function armWatchdog(): void {
      watchdog = setTimeout(() => {
        finish({ flowId, kind: 'error', msg: cancelMsg });
      }, cancelGraceMs);
      // Never keep the app (or a jest worker) alive for this.
      watchdog.unref();
    }
    // Armed ONLY by a cancel — `flow.abort.abort()` is the one moment a flow
    // is known to be abandoned. A flow nobody cancelled is never
    // force-terminated: a picker modal may legitimately sit open for minutes,
    // and a timeout there would archive-or-abandon a scope edit the user is
    // still making.
    flow.abort.signal.addEventListener('abort', armWatchdog, { once: true });

    void (async () => {
      try {
        const account = await platform.store.account(accountId);
        if (!account) throw new Error(`unknown account: ${accountId}`);
        sourceId = account.source;
        finish(
          await body({
            flowId,
            flow,
            account,
            stage: (next) => {
              stage = next;
            },
          }),
        );
      } catch (err) {
        // A user cancel is not a failure: it produces an error EVENT (the
        // renderer needs to leave its spinner) but no failure record.
        if (!flow.cancelled)
          logFolderFlowFailure(platform.logSink, folderFlowStage(stage, err), {
            accountId,
            sourceId,
            error: err,
          });
        finish({
          flowId,
          kind: 'error',
          msg: String(err instanceof Error ? err.message : err),
        });
      }
    })();
    return { flowId };
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
    start(
      sourceId: string,
      opts?: { oauthClient?: OAuthClientOverride },
    ): { flowId: string } {
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
            profile.authUrl(scopes, profile.redirectUri, opts?.oauthClient),
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
            // C-3: this task owns these two lines. The connect path always
            // starts a NEW account, so `purpose` defaults to 'connect'.
            // B-2: `FolderPickerSpec.selected` is optional and the wire field
            // is required, so an omitted selection bridges to [] and becomes
            // indistinguishable from an explicit empty one — which is why the
            // modal's empty-selection rule keys off `purpose`, never length.
            selected: spec.selected ?? [],
            purpose: spec.purpose ?? 'connect',
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

    /** Re-authenticate ONE existing account. Never calls connect(): that
     *  upserts config through createAccount and would replace the account's
     *  folder scope with whatever the source's connect() returns.
     *
     *  This IS the signature DECISIONS freezes for reconnect — `(accountId,
     *  opts?: { oauthClient? })`. It lives here rather than on the engine
     *  because `opts.oauthClient` is consumed at exactly one place, `authUrl`
     *  below, and the profile registry it needs is broker-private. */
    startReconnect(
      accountId: AccountId,
      opts?: { oauthClient?: OAuthClientOverride },
    ): { flowId: string } {
      return runAccountFlow(
        accountId,
        'reauth-provider',
        'reconnect cancelled',
        async ({ flowId, flow, account }) => {
          const auth: AuthChannel = {
            ...makePickerChannel(flowId),
            async oauth(scopes: string[]): Promise<Credentials> {
              const profile = oauthProfiles.get(account.source);
              if (!profile)
                throw new Error(
                  `no OAuth profile registered for ${account.source}`,
                );
              send({ flowId, kind: 'status', msg: 'Waiting for sign-in…' });
              const callbackUrl = await runOAuthLoopback(
                profile.authUrl(scopes, profile.redirectUri, opts?.oauthClient),
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
              answers.catch(() => {});
              send({ flowId, kind: 'prompt', requestId, schema });
              return answers;
            },
          };
          await platform.engine.reconnect(account.id, auth, flow.abort.signal);
          // **C-28.3 — there is deliberately no `if (flow.cancelled) throw`
          // here, and its absence is the fix.** `engine.reconnect` RESOLVES
          // only after its point of no return: the loop is stopped, the
          // credentials are saved and the status is committed. A cancel that
          // raced past the engine's own pre-commit check therefore arrives at
          // an account that has already been changed — and the old code's
          // answer to that was to skip `runAccount` and report "cancelled",
          // leaving the account stopped, re-credentialled and unscheduled. A
          // cancelled reconnect that already committed is just a reconnect;
          // the worst outcome now is a UI that briefly said "cancelling" over
          // an account that is healthy and syncing. (A cancel BEFORE the
          // commit still throws — inside the engine — and lands in the catch
          // above, which is the path the mid-flight test in Step 25 drives.)
          const fresh = await platform.store.account(account.id);
          if (fresh) runAccount(platform, fresh);
          return { flowId, kind: 'reconnected', accountId: account.id };
        },
      );
    },

    /** Edit ONE account's folder scope with its EXISTING credentials. Never
     *  authenticates (the channel has no oauth/prompt verb at all), and never
     *  removes anything on cancel. */
    startManageFolders(accountId: AccountId): { flowId: string } {
      return runAccountFlow(
        accountId,
        'folder-validate',
        'folder selection cancelled',
        async ({ flowId, flow, account, stage }) => {
          const source = platform.sources.get(account.source);
          if (!source) throw new Error(`unknown source: ${account.source}`);
          if (!source.manageFolders)
            throw new Error(
              `${account.source} does not support managing folders`,
            );
          // R4: the picker cannot list anything without valid credentials, and
          // Session.credentials() RETHROWS an auth-coded refresh failure
          // (engine.ts:406-414) — so this would fail mid-picker rather than
          // never opening.
          if (account.status === 'needsReauth')
            throw new Error(
              'reconnect this source before managing its folders',
            );
          // Snapshot BEFORE the picker opens: this is the "did the world change
          // while the user was clicking" question, and — **C-28.2** — it is
          // also the value handed to `applyScope` as the store's CAS baseline.
          // ONE snapshot, taken once, used for both. The comparison below is
          // the fail-fast half (refuse before quiescing the account); the CAS
          // is the authoritative half, because the window between that
          // comparison and the transaction is still real. Letting `applyScope`
          // fetch its own baseline instead — what it used to do — closes
          // neither window: the fresher read blesses whatever landed in
          // between, and `applyFolderScope`'s `UPDATE accounts SET config = ?`
          // then overwrites it with nobody told.
          // The other writer is usually connect-broker.start(): an Add of the
          // same provider account upserts through createAccount and rewrites
          // config, and start() cannot take the per-account lock because it has
          // no account id until connect() has already returned.
          const configAtOpen = JSON.stringify(account.config);
          const session = platform.engine.session(
            account,
            flow.abort.signal,
            `source:${account.source}`,
          );
          stage('folder-list');
          const update: FolderScopeUpdate = await source.manageFolders(
            session,
            makePickerChannel(flowId),
          );
          if (flow.cancelled) throw new Error('folder selection cancelled');
          stage('folder-stale');
          const current = await platform.store.account(accountId);
          if (!current) throw new Error(`unknown account: ${accountId}`);
          if (JSON.stringify(current.config) !== configAtOpen)
            throw new FolderScopeStaleError();
          // From here the transaction is durable and atomic: a cancel arriving
          // after it must NOT skip the restart, or the account sits at the new
          // scope with no loop. So no cancelled check below this line.
          stage('folder-commit');
          // The update crosses UNCHANGED — config, cursor,
          // archiveScopeRootIds and (C-46/D5) reattributeScopeRoots are the
          // SOURCE's answers (R8/A-1). The one
          // field the engine does NOT honour is `archiveNullScoped`, which it
          // does not even forward (C-27/C-34: the store's input type has no
          // such property in this train); that decision lives in `applyScope`,
          // not here, so the broker stays a courier.
          await platform.engine.applyScope(accountId, update, configAtOpen);
          const before = new Set(folderRootIds(account.config));
          const after = folderRootIds(update.config);
          const retained = after.filter((id) => before.has(id)).length;
          const counts = {
            added: after.length - retained,
            retained,
            removed: before.size - retained,
          };
          logScopeChanged(platform.logSink, {
            accountId,
            sourceId: account.source,
            ...counts,
          });
          return { flowId, kind: 'scope-saved', accountId, ...counts };
        },
      );
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
