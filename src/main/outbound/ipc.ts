/**
 * IPC delegate for the in-app Outbox (spec §10, Airy §9).
 *
 * SECURITY POSTURE: the renderer never sends or receives a URL or a token.
 * It names a draft id. Review in the browser: this module mints the signed
 * confirm URL main-side and hands it to the injected `openExternal`. Review
 * in the app (Airy §9): `outbox:send` runs the page confirm's OWN gate and
 * send (`service.sendById` → the shared `confirmRow`), so the in-app Send
 * can never do what the page's Send button could not. No token there: a
 * token proves possession of a link that may leak; in the app the caller is
 * the user's own renderer (the sender guard admits only it), and the bound
 * is the row's own `expires_at`, which `confirmRow`'s sweep applies.
 *
 * CLASSIFICATION POSTURE: `error-copy.ts` is main-process code and the
 * renderer must not import across that layer, so every failure verdict is
 * computed HERE and rides the wire on `OutboxPanelRow`.
 */
import type { Account, AccountId, OutboxRow } from '@shared/contracts';
import type {
  InvokeHandlers,
  OutboxDraftDetail,
  OutboxPanelRow,
} from '@shared/ipc';

import type { CoreStore } from '../core/store/store';
import { shapeOutboundError } from './error-copy';
import type { OutboundService } from './service';

/** `baseFor()` throws this bare internal string when the loopback server
 *  never bound (service.ts:158-171). It must never reach a user's screen. */
const NOT_READY = 'outbound: server not ready';
const NOT_READY_HUMAN =
  'the local server is not running — try restarting the app';

/** Wraps any call that can reach `baseFor()`. */
async function minting<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes(NOT_READY)) throw new Error(NOT_READY_HUMAN);
    throw e;
  }
}

/** The row's error projection, gated on its CURRENT status.
 *
 *  `transition` only ever SETs patch fields (outbox.ts:42-48) — the table is
 *  an audit log — so a retried failed→sending→sent row still carries its old
 *  `error` string. Reading it ungated would paint a red failure line under a
 *  green "Sent" row. This mirrors the same gate `listOutbox` applies for the
 *  model (service.ts:582-587). */
function errorFieldsOf(
  row: OutboxRow,
): Pick<
  OutboxPanelRow,
  'error' | 'errorDetail' | 'canRetry' | 'deliveryUncertain'
> {
  if (row.status === 'failed') {
    const shaped = shapeOutboundError(row.error ?? '');
    return {
      error: shaped.message,
      errorDetail: shaped.summary,
      canRetry: shaped.canRetry,
      // NOT `!shaped.canRetry`: an 'unsupported' failure is also
      // non-retryable but was PROVABLY never sent, and keeps its one-click
      // "Draft again". Only 'unknown' means "it may have gone out".
      deliveryUncertain: shaped.kind === 'unknown',
    };
  }
  if (row.status === 'delivery_unknown') {
    // Already a human sentence (outbox.ts:253-255, recoverOrphanedSending).
    // Running it through shapeOutboundError would wrap a perfectly good
    // sentence in a `send failed: ` prefix.
    return {
      error: row.error,
      errorDetail: null,
      canRetry: false,
      deliveryUncertain: true,
    };
  }
  return {
    error: null,
    errorDetail: null,
    canRetry: false,
    deliveryUncertain: false,
  };
}

/** One row on the wire — the ONE mapping `outbox:list` and `outbox:get`
 *  share. `account` null = it vanished (the FK cascades, so only a race). */
function panelRow(row: OutboxRow, account: Account | null): OutboxPanelRow {
  return {
    draftId: row.id,
    status: row.status,
    kind: row.kind,
    accountLabel: account?.identifier ?? '(removed)',
    recipientDisplay: row.recipientDisplay,
    subject: row.subject,
    bodyPreview: row.bodyMarkdown.replace(/\s+/g, ' ').trim().slice(0, 140),
    createdAt: row.createdAt,
    sentAt: row.sentAt,
    to: row.to,
    cc: row.cc,
    sourceId: account?.source ?? '',
    createdBy: row.createdBy,
    createdVia: row.createdVia,
    ...errorFieldsOf(row),
  };
}

/** The eight outbox channels, as a slice of main's exhaustive handler map.
 *
 *  Returned rather than registered, for the same reason as the updater's
 *  slice: a module that registers its own channels sits outside the one map
 *  that can be checked for completeness, so a declared-but-unregistered
 *  channel stays a runtime "No handler registered" instead of a compile
 *  error. The injected `handle` this used to take is what the `as never`
 *  double-cast at the call site existed to satisfy. */
export function outboundInvokeHandlers(deps: {
  service: OutboundService;
  store: CoreStore;
  /** `shell.openExternal` in production; injected so tests can observe it. */
  openExternal: (url: string) => Promise<void>;
}): Pick<
  InvokeHandlers,
  | 'outbox:list'
  | 'outbox:pending-count'
  | 'outbox:discard'
  | 'outbox:open-confirm'
  | 'outbox:redraft'
  | 'outbox:get'
  | 'outbox:send'
  | 'outbox:sender-sources'
> {
  const { service, store, openExternal } = deps;

  return {
    // `req` is read defensively rather than destructured in the parameter
    // list: `{ limit?: number }` is the only ALL-optional req in `Invokes`,
    // and the contextBridge surface (`window.kiagent.invoke`,
    // preload.ts:11-16) passes whatever it is handed straight through —
    // types are erased there, so a payload-less call reaches
    // `ipcMain.handle`'s `fn(req)` as `undefined` and would TypeError on the
    // panel's PRIMARY read. Every other destructured handler has a required
    // payload, so there is no precedent telling a caller the `{}` is
    // mandatory.
    'outbox:list': async (req) => {
      // The sweep and the [1,100] RANGE clamp `service.listOutbox` applies
      // (service.ts:551-562), which this path would otherwise bypass. Without
      // the sweep the panel shows a stale 'draft' row whose Review & send then
      // dies; without the clamp a negative LIMIT reads as UNBOUNDED in SQLite
      // and returns the whole table, and NaN/Infinity would poison the math.
      await store.outbox.expireOverdue();
      const limit = req?.limit;
      const clamped = Number.isFinite(limit)
        ? Math.min(100, Math.max(1, Math.floor(limit as number)))
        : 50;
      // `before` is the wire-level keyset cursor. Issue #113 names its field
      // `draftId`; the store's `list()` (task 8) names the matching field
      // `id`, matching `OutboxRow.id` — mapped here at the IPC boundary, the
      // store's own name stays untouched.
      // `status` is forwarded exactly as received — including the
      // undefined-vs-empty-array distinction (store/outbox.ts's `list`):
      // an absent `status` means every row, a present-but-empty `status: []`
      // means none. This handler must never default a missing `status` to
      // `[]` or coerce an empty one away.
      const rows = await store.outbox.list({
        limit: clamped,
        status: req?.status,
        before: req?.before && {
          createdAt: req.before.createdAt,
          id: req.before.draftId,
        },
      });

      const accounts = new Map<AccountId, Account | null>();
      const out: OutboxPanelRow[] = [];
      for (const row of rows) {
        if (!accounts.has(row.accountId)) {
          // The outbox FK is ON DELETE CASCADE (schema.ts:205), so removing an
          // account erases its rows — '(removed)' is only reachable if the
          // account vanished between listRecent and this lookup.
          accounts.set(row.accountId, await store.account(row.accountId));
        }
        out.push(panelRow(row, accounts.get(row.accountId) ?? null));
      }
      return out;
    },

    'outbox:pending-count': async () => {
      await store.outbox.expireOverdue();
      return { pending: await store.outbox.countPending() };
    },

    'outbox:discard': async ({ draftId }) => {
      // Result ignored on purpose: losing the race (the row left 'draft'
      // meanwhile) is a fine outcome — the panel refetches and shows whatever
      // actually happened. Mints nothing, so no `minting` wrapper is needed.
      await store.outbox.transition(draftId, ['draft'], 'discarded');
    },

    'outbox:open-confirm': async ({ draftId }) => {
      const url = await minting(() => service.confirmUrlFor(draftId));
      if (!url) {
        // Name the ACTUAL status, the way the service does elsewhere
        // (service.ts:652-656). Do not say the draft is merely still pending
        // or not: confirmUrlFor also serves retryable failed rows, so a
        // pending/not-pending phrasing is wrong for every failed row that IS
        // openable and misleading for the ones that aren't.
        const row = await store.outbox.get(draftId);
        throw new Error(
          `this draft can no longer be opened — its status is ` +
            `'${row?.status ?? 'unknown'}'`,
        );
      }
      await openExternal(url);
    },

    'outbox:redraft': async ({ draftId }) => {
      // redraft() calls assertReady() before its insert, so a cold base throws
      // here rather than leaving an orphan row. The fresh draft opens in the
      // app's review sheet (Airy §9), not the browser.
      const fresh = await minting(() => service.redraft(draftId));
      return { draftId: fresh.id };
    },

    'outbox:get': async ({ draftId }) => {
      await store.outbox.expireOverdue();
      const row = await store.outbox.get(draftId);
      if (!row) return null;
      const detail: OutboxDraftDetail = {
        ...panelRow(row, await store.account(row.accountId)),
        body: row.bodyMarkdown,
        confirmMode: row.confirmMode,
      };
      return detail;
    },

    'outbox:send': async ({ draftId }) => {
      const outcome = await service.sendById(draftId);
      if (outcome.kind === 'invalid') return { outcome: 'gone', row: null };
      const kind =
        outcome.kind === 'sent' || outcome.kind === 'failed'
          ? outcome.kind
          : 'already';
      return {
        outcome: kind,
        row: panelRow(outcome.row, await store.account(outcome.row.accountId)),
      };
    },

    'outbox:sender-sources': async () => service.senderSources(),
  };
}
