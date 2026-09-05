import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { ConnectEvent } from '@shared/ipc';
import type { Account, AccountId, FolderNode } from '@shared/contracts';
import { Icon } from '@shared/web-ui/icon-sprite';
import { useAppState } from '@renderer/state/app-state';
import { FolderPickerField } from '@renderer/components/FolderPickerField';
import { FolderPickerModal } from '@renderer/components/folder-picker/FolderPickerModal';
import { connectorMeta, sourceLabel } from './connector-meta';
import {
  createConnectPickerAdapter,
  type PickerRequest,
} from './connect-picker-adapter';
import { schemaFields, schemaGuidance } from './prompt-guidance';
import { GuidanceSteps } from './GuidanceSteps';
import { SourceIcon } from './SourceIcon';
import { useSourceDescriptors } from './sources-registry';
import { openFlow } from './flow-client';

/**
 * In-place "add a source" panel — swapped in over the Sources body, matching
 * the legacy AddSource screen's non-modal tile-grid + wizard (ui-inventory.md
 * §2.7, docs/screens/add-source.html). A tile per registered `SourceDescriptor`
 * (icon + label from connector-meta.ts) starts a CONNECT flow
 * (`accounts:add`); the ErrorCard/SourceDetail Reconnect paths start a
 * RECONNECT flow (`accounts:start-reconnect`) or, for a source with no
 * `reauthenticate`, fall back to the same connect route (C-9); and A-4's
 * machine-scoped carve-out routes an existing local-folder account's "Add" to
 * a MANAGE flow (`accounts:start-manage-folders`) instead of upserting over
 * it. All three funnel through one `push:connect` listener rendering whatever
 * the flow sends: a status line, a QR code, a schema-driven prompt form, a
 * folder picker, or one of the three terminals (done / reconnected /
 * scope-saved) / error. Flow states render as a centered wizard card;
 * guidance steps come from the schema's x-steps (prompt-guidance.ts).
 */

/**
 * Sources whose `connect()` returns a FIXED identifier, so `createAccount`'s
 * `ON CONFLICT(source, identifier) DO UPDATE` (store.ts:1059-1064) can never make a
 * second account: local-folder pins `identifier` to
 * `MACHINE_IDENTIFIER = 'this-machine'` (local-folder-source.ts:47, :74-113).
 * Adding a folder through `accounts:add` therefore REPLACES the existing
 * account's config wholesale and re-drives reconciliation
 * (engine.ts:546-556, `reconcileAllowances.add` at :555), archiving every root
 * not in the new config — a silent corpus wipe on the ordinary two-click
 * "add another folder" (A-4).
 *
 * For these sources a second "add" is really a MANAGE, so `pick` routes it to
 * the account-scoped folder-scope flow. Deliberately NOT keyed on
 * `descriptor.multiAccount`: local-folder declares `multiAccount: true`
 * (local-folder-source.ts:33-43) while pinning a constant identifier, so that
 * flag says nothing about this hazard.
 */
const MACHINE_SCOPED_SOURCE_IDS: ReadonlySet<string> = new Set([
  'local-folder',
]);

interface FlowState {
  flowId: string;
  sourceId: string;
  /** Which flow this is. Drives the wizard heading and names the terminal
   *  event to expect: `connect` → `done`, `reconnect` → `reconnected`,
   *  `manage` → `scope-saved`. */
  mode: 'connect' | 'reconnect' | 'manage';
  status?: string;
  qr?: string;
  prompt?: { requestId: string; schema: unknown };
  /** A pickFolders in progress — renders FolderPickerModal over a
   *  source-served tree (see connect-picker-adapter.ts). A-6's PickerRequest
   *  with the wire's required fields narrowed; `selected` is the complete
   *  current covering set, pre-checked and REMOVABLE, and `purpose` drives the
   *  modal's copy. */
  picker?: PickerRequest & {
    multiSelect: boolean;
    selected: FolderNode[];
    purpose: 'connect' | 'manage';
  };
  error?: string;
  done?: Account;
  /** Terminal event of a reconnect flow — the account already exists, so this
   *  carries an id rather than `done`'s freshly created `Account`. */
  reconnected?: AccountId;
  /** Terminal event of a manage-folders flow. */
  scopeSaved?: { accountId: AccountId; added: number; removed: number };
}

/** Renders `qr` as a scannable <img> (data URL from the `qrcode` package,
 *  loaded dynamically so a bundling hiccup degrades gracefully) — falls back
 *  to a styled monospace block of the raw payload if encoding fails. */
function QrCode(props: { data: string }): React.ReactElement {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setDataUrl(null);
    setFailed(false);
    import('qrcode')
      .then((qrcode) => qrcode.toDataURL(props.data, { margin: 1, width: 200 }))
      .then((url) => {
        if (!cancelled) setDataUrl(url);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [props.data]);

  if (dataUrl) {
    return (
      <img
        src={dataUrl}
        width={200}
        height={200}
        alt="Scan to connect"
        className="as-qr-img"
      />
    );
  }
  if (failed) {
    // TODO(sources): the `qrcode` renderer package didn't load/encode in this
    // build — falling back to the raw payload so pairing still works, just
    // without a scannable image.
    return <pre className="as-flow-qr">{props.data}</pre>;
  }
  return <div className="t-meta">Rendering QR code…</div>;
}

export function AddSourcePanel(props: {
  onDone: (accountId?: AccountId) => void;
  /** Reconnect THIS account instead of adding a new one — the ErrorCard and
   *  SourceDetail Reconnect paths. On mount this starts
   *  `accounts:start-reconnect` when the source's descriptor carries
   *  `hasReauthenticate: true`, and today's `pick()` → `accounts:add
   *  { sourceId }` otherwise (C-9); the tile grid is never shown either way.
   *  `sourceId`/`identifier` are carried so the
   *  panel can title itself and name the outcome without re-reading app-state
   *  (and so alpha-cent's shadow can put its BYO-OAuth gate in front of a
   *  gated source's reconnect — R2). */
  reconnect?: { accountId: AccountId; sourceId: string; identifier: string };
}): React.ReactElement {
  const descriptors = useSourceDescriptors();
  // Every account currently in the app-state projection — read unconditionally
  // (Rules of Hooks: this component has an early `if (flow)` return below) so
  // `pick`'s A-4 machine-scoped lookup always sees the CURRENT projection
  // rather than a snapshot from whenever the panel mounted.
  const accountEntries = useAppState((s) => s.accounts);
  const [flow, setFlow] = useState<FlowState | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [addError, setAddError] = useState<string | null>(null);
  const unsubscribeRef = useRef<(() => void) | null>(null);

  // Adapter for the CURRENT `folder-picker` event — rebuilt only when a new
  // event object (new requestId) lands, so its path→FolderNode map survives
  // re-renders while the modal is open.
  const picker = flow?.picker ?? null;
  const pickerAdapter = useMemo(
    () => (picker ? createConnectPickerAdapter(picker) : null),
    [picker],
  );
  // requestId whose selection was confirmed: the modal fires onClose right
  // after onConfirm, and only an UNconfirmed close may cancel the flow's
  // pending pickFolders. (A new event's requestId never matches an old one,
  // so no reset is needed.)
  const pickerConfirmedForRef = useRef<string | null>(null);
  // The picker open RIGHT NOW, for the unmount cleanup below: leaving the
  // panel (header Cancel → props.onDone, or any unmount) with a picker still
  // open must cancel the flow's pending pickFolders, or its broker/child
  // entries live until app quit — the settle sweep never fires for a flow
  // that never settles. Render-maintained ref, mirroring the modal's
  // dataSourceRef pattern.
  const openPickerRef = useRef<{
    requestId: string;
    cancel: () => Promise<void>;
  } | null>(null);
  openPickerRef.current =
    picker && pickerAdapter
      ? { requestId: picker.requestId, cancel: () => pickerAdapter.cancel() }
      : null;
  // The LIVE (unsettled) flow, for the unmount cleanup and the Back button:
  // leaving the panel mid-flow must cancel it main-side (reject its pending
  // prompt, close its OAuth window, block a late connect() from creating an
  // account) — otherwise the suspended connect() frame and its broker/child
  // entries live until app quit. Render-maintained ref, mirroring
  // openPickerRef; null once the flow settled (done/error), so a stale
  // cancel is never sent for a finished flow.
  const liveFlowRef = useRef<string | null>(null);
  liveFlowRef.current =
    flow && !flow.done && !flow.error && !flow.reconnected && !flow.scopeSaved
      ? flow.flowId
      : null;

  const cancelFlowMainSide = (): void => {
    const flowId = liveFlowRef.current;
    liveFlowRef.current = null;
    if (flowId) {
      // Fire-and-forget: racing a flow that settled a beat earlier is a
      // main-side no-op by contract.
      void window.kiagent
        .invoke('accounts:cancel-flow', { flowId })
        .catch(() => {});
    }
  };

  useEffect(
    () => () => {
      unsubscribeRef.current?.();
      unsubscribeRef.current = null;
      const open = openPickerRef.current;
      openPickerRef.current = null;
      if (open && pickerConfirmedForRef.current !== open.requestId) {
        // Racing a flow that settled a beat earlier just rejects with
        // "unknown picker request" — swallow it.
        void open.cancel().catch(() => {});
      }
      // Any unmount with the flow still unsettled (header Cancel →
      // props.onDone, navigation away) cancels it main-side.
      cancelFlowMainSide();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // Starts at most once, even though this effect re-runs when `descriptors`
  // arrives.
  const reconnectStartedRef = useRef(false);

  // The Reconnect path skips the tile grid and goes straight into a flow.
  // WHICH flow the descriptor decides (C-9): `engine.reconnect` throws
  // `<source> cannot be reconnected — remove this source and add it again`
  // for any source with no `reauthenticate` method, and only the three
  // folder-scoped sources gain one in this train — imap (needsReauth on every
  // expired password), microsoft and whatsapp do not. An unflagged source
  // therefore keeps TODAY'S route: `pick()`, i.e. accounts:add { sourceId }.
  // C-20 — THE DESCRIPTORS WAIT, and the reason this gate lives here rather
  // than in SourcesList: both Reconnect entry points (the ErrorCard and
  // SourceDetail's topbar) funnel through this one mount effect.
  // `useSourceDescriptors()` is null until sources:list resolves and [] if it
  // failed (sources-registry.tsx:15-31), so a null list is a WAIT (deps
  // [descriptors]) — routing on null would push a reauth-capable source down
  // the add path on every cold open, and the started-once latch would make
  // that permanent. [] is not a wait: it routes to the safe fallback at once. `begin` and `pick` are hoisted function declarations, so
  // calling them from here is safe; the unmount cleanup above covers either
  // flow.
  useEffect(() => {
    const rc = props.reconnect;
    if (!rc || reconnectStartedRef.current || descriptors === null) return;
    reconnectStartedRef.current = true;
    const canReauth =
      descriptors.find((d) => d.id === rc.sourceId)?.hasReauthenticate === true;
    if (canReauth) {
      void begin(rc.sourceId, 'reconnect', () =>
        window.kiagent.invoke('accounts:start-reconnect', {
          accountId: rc.accountId,
        }),
      );
      return;
    }
    // Today's route, unchanged, and THROUGH `pick` — never a second
    // accounts:add thunk. `pick` stays the only caller of that channel
    // (decision 1), and going through it means the fallback inherits A-4's
    // gate: R4 offers Reconnect on an `error` account too, and a local-folder
    // account there must route to manage-folders, never to the
    // (source, identifier) upsert that would archive its other roots.
    void pick(rc.sourceId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [descriptors]);

  async function begin(
    sourceId: string,
    mode: FlowState['mode'],
    start: () => Promise<{ flowId: string }>,
  ): Promise<void> {
    setAddError(null);

    const applyEvent = (evt: ConnectEvent): void => {
      setFlow((prev) => {
        if (!prev) return prev;
        // NOTE: status/qr/prompt clearing `picker` mirrors the pre-existing
        // prompt-orphaning semantics (status has always cleared `prompt`):
        // a source that emits while its own pickFolders/prompt is still
        // pending abandons that pending call — the flow can then only end
        // via error/cancel. Inherited wart, kept deliberately consistent.
        switch (evt.kind) {
          case 'status':
            return {
              ...prev,
              status: evt.msg,
              qr: undefined,
              prompt: undefined,
              picker: undefined,
            };
          case 'qr':
            return {
              ...prev,
              qr: evt.qr,
              prompt: undefined,
              picker: undefined,
            };
          case 'prompt':
            return {
              ...prev,
              prompt: { requestId: evt.requestId, schema: evt.schema },
              picker: undefined,
            };
          case 'folder-picker':
            return {
              ...prev,
              prompt: undefined,
              qr: undefined,
              picker: {
                requestId: evt.requestId,
                multiSelect: evt.multiSelect,
                modes: evt.modes,
                selected: evt.selected,
                purpose: evt.purpose,
              },
            };
          case 'done':
            unsubscribeRef.current?.();
            return {
              ...prev,
              done: evt.account,
              prompt: undefined,
              picker: undefined,
            };
          case 'reconnected':
            unsubscribeRef.current?.();
            return {
              ...prev,
              reconnected: evt.accountId,
              prompt: undefined,
              picker: undefined,
            };
          case 'scope-saved':
            unsubscribeRef.current?.();
            return {
              ...prev,
              scopeSaved: {
                accountId: evt.accountId,
                added: evt.added,
                removed: evt.removed,
              },
              prompt: undefined,
              picker: undefined,
            };
          case 'error':
            unsubscribeRef.current?.();
            return {
              ...prev,
              error: evt.msg,
              prompt: undefined,
              picker: undefined,
            };
          default:
            return prev;
        }
      });
    };

    try {
      await openFlow(start, applyEvent, {
        onSubscribed: (unsubscribe) => {
          unsubscribeRef.current = unsubscribe;
        },
        onFlowId: (flowId) => setFlow({ flowId, sourceId, mode }),
      });
    } catch (err) {
      // openFlow already unsubscribed on its own throw path; drop our
      // reference too so a later unmount doesn't call it again.
      unsubscribeRef.current = null;
      setAddError(err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * The tile grid's entry point, and the C-9 reconnect fallback's. A-4: for a
   * machine-scoped source that ALREADY has an account, "add" means "manage
   * that account's folders" — `accounts:add` there would upsert over the
   * existing account and archive every root it currently tracks. Both callers
   * pass through this gate; there is no other route into `accounts:add`.
   */
  async function pick(sourceId: string): Promise<void> {
    const existing = MACHINE_SCOPED_SOURCE_IDS.has(sourceId)
      ? (accountEntries.find((e) => e.account.source === sourceId)?.account ??
        null)
      : null;
    if (existing) {
      await begin(sourceId, 'manage', () =>
        window.kiagent.invoke('accounts:start-manage-folders', {
          accountId: existing.id,
        }),
      );
      return;
    }
    await begin(sourceId, 'connect', () =>
      window.kiagent.invoke('accounts:add', { sourceId }),
    );
  }

  async function submitPrompt(): Promise<void> {
    if (!flow?.prompt) return;
    await window.kiagent.invoke('accounts:prompt-answer', {
      requestId: flow.prompt.requestId,
      answers,
    });
    setAnswers({});
  }

  const cancelFlow = (): void => {
    unsubscribeRef.current?.();
    unsubscribeRef.current = null;
    // No-op when the flow already settled (the error-state Back button) —
    // liveFlowRef is null then.
    cancelFlowMainSide();
    setFlow(null);
  };

  if (flow) {
    // Computed once per render (rather than inline in the ternaries below) so
    // the classic-form branch isn't a re-parse of the same schema.
    const promptFields = flow.prompt ? schemaFields(flow.prompt.schema) : null;
    const guidance = flow.prompt ? schemaGuidance(flow.prompt.schema) : null;

    // Modal branch renders outside the wizard card (it overlays the app).
    // `selected` comes from the ADAPTER, exactly as in `TrackedFolders`
    // (C-2/C-7) — `picker.selected` is the adapter's input (contracts.
    // FolderNode, no `path`) and must never reach the modal.
    if (picker && pickerAdapter) {
      return (
        // AuthChannel.pickFolders — the same modal, served by the SOURCE's
        // tree callbacks over the accounts:picker-* invokes. Confirm maps
        // the confirmed ids back to FolderNodes and resolves the flow's
        // pending pickFolders; an unconfirmed close cancels it (connect()
        // throws, the flow's own error event renders below).
        <FolderPickerModal
          key={picker.requestId}
          multiSelect={picker.multiSelect}
          dataSource={pickerAdapter.dataSource}
          selected={pickerAdapter.selected}
          expandIds={pickerAdapter.expandIds}
          purpose={picker.purpose}
          onConfirm={(ids) => {
            pickerConfirmedForRef.current = picker.requestId;
            // A confirm racing a flow that already settled (extension
            // crash) rejects with "unknown picker request"; the flow's own
            // error event is what the user sees — just log it.
            void pickerAdapter.confirm(ids).catch((err) => {
              // eslint-disable-next-line no-console
              console.warn('folder picker: confirm failed', err);
            });
            setFlow((prev) => (prev ? { ...prev, picker: undefined } : prev));
          }}
          onClose={() => {
            if (pickerConfirmedForRef.current !== picker.requestId) {
              void pickerAdapter.cancel().catch(() => {});
            }
            setFlow((prev) => (prev ? { ...prev, picker: undefined } : prev));
          }}
        />
      );
    }

    return (
      <div className="as-panel">
        <div className="as-wizard card">
          <div className="as-wizard-head">
            <SourceIcon sourceId={flow.sourceId} size={28} />
            <span className="h-section">
              {flow.mode === 'reconnect'
                ? 'Reconnect'
                : flow.mode === 'manage'
                  ? 'Add folders to'
                  : 'Connect'}{' '}
              {sourceLabel(flow.sourceId, descriptors)}
            </span>
          </div>

          {flow.reconnected ? (
            <>
              <div className="as-flow-msg">
                <Icon
                  name="check-circle"
                  size={14}
                  style={{ color: 'var(--live-solid)' }}
                />
                Reconnected:{' '}
                <span className="mono">{props.reconnect?.identifier}</span>
              </div>
              <div className="as-wizard-foot">
                <button
                  type="button"
                  className="btn primary sm"
                  onClick={() => props.onDone(flow.reconnected)}
                >
                  Done
                </button>
              </div>
            </>
          ) : flow.scopeSaved ? (
            <>
              <div className="as-flow-msg">
                <Icon
                  name="check-circle"
                  size={14}
                  style={{ color: 'var(--live-solid)' }}
                />
                Folders updated — {flow.scopeSaved.added} added,{' '}
                {flow.scopeSaved.removed} removed.
              </div>
              <div className="as-wizard-foot">
                <button
                  type="button"
                  className="btn primary sm"
                  onClick={() => props.onDone(flow.scopeSaved?.accountId)}
                >
                  Done
                </button>
              </div>
            </>
          ) : flow.done ? (
            <>
              <div className="as-flow-msg">
                <Icon
                  name="check-circle"
                  size={14}
                  style={{ color: 'var(--live-solid)' }}
                />
                Connected: <span className="mono">{flow.done.identifier}</span>
              </div>
              <div className="as-wizard-foot">
                <button
                  type="button"
                  className="btn primary sm"
                  onClick={() => props.onDone(flow.done?.id)}
                >
                  Done
                </button>
              </div>
            </>
          ) : flow.error ? (
            <>
              <div className="as-flow-msg err">
                <Icon name="alert-circle" size={14} />
                {flow.error}
              </div>
              <div className="as-wizard-foot">
                <button type="button" className="btn sm" onClick={cancelFlow}>
                  ← Back
                </button>
                <button
                  type="button"
                  className="btn sm"
                  onClick={() => props.onDone()}
                >
                  Cancel
                </button>
              </div>
            </>
          ) : flow.prompt ? (
            <form
              className="as-wizard-form"
              onSubmit={(e) => {
                e.preventDefault();
                void submitPrompt();
              }}
            >
              {guidance?.intro && (
                <p className="t-meta as-wizard-intro">{guidance.intro}</p>
              )}
              <GuidanceSteps steps={guidance?.steps ?? []} />
              {(promptFields ?? []).map(
                ({ key, label, secret, folder, placeholder, help }) =>
                  folder ? (
                    // A <label> wrapping both a text input AND a button would
                    // make a label click ambiguous (which control should it
                    // focus/activate?) — use a plain field wrapper instead.
                    <div key={key} className="as-field">
                      <span className="kg-label">{label}</span>
                      <FolderPickerField
                        value={answers[key] ?? ''}
                        onChange={(v) =>
                          setAnswers((a) => ({ ...a, [key]: v }))
                        }
                      />
                      {help && <span className="as-field-help">{help}</span>}
                    </div>
                  ) : (
                    <label key={key} className="as-field">
                      <span className="kg-label">{label}</span>
                      <input
                        className="input"
                        type={secret ? 'password' : 'text'}
                        placeholder={placeholder}
                        value={answers[key] ?? ''}
                        onChange={(e) =>
                          setAnswers((a) => ({ ...a, [key]: e.target.value }))
                        }
                      />
                      {help && <span className="as-field-help">{help}</span>}
                    </label>
                  ),
              )}
              <div className="as-wizard-foot">
                <button
                  type="button"
                  className="btn sm"
                  onClick={() => props.onDone()}
                >
                  Cancel
                </button>
                <button type="submit" className="btn primary sm">
                  Connect
                </button>
              </div>
            </form>
          ) : flow.qr ? (
            <>
              <div className="t-meta">Scan this code with your device:</div>
              <QrCode data={flow.qr} />
              <div className="as-wizard-foot">
                <button
                  type="button"
                  className="btn sm"
                  onClick={() => props.onDone()}
                >
                  Cancel
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="as-flow-msg">
                <span className="spinner" />
                {flow.status ?? 'Connecting…'}
              </div>
              <div className="as-wizard-foot">
                <button
                  type="button"
                  className="btn sm"
                  onClick={() => props.onDone()}
                >
                  Cancel
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="as-panel">
      <div className="as-head">
        <span className="as-title">Add a source</span>
        <span className="t-meta as-sub">Everything stays on this machine.</span>
        <div style={{ flex: 1 }} />
        <button type="button" className="btn sm" onClick={() => props.onDone()}>
          Cancel
        </button>
      </div>

      {addError && <div className="si-error">{addError}</div>}

      <div className="as-grid">
        {descriptors === null ? (
          <div className="t-meta">Loading sources…</div>
        ) : descriptors.length === 0 ? (
          <div className="t-meta">No sources available.</div>
        ) : (
          descriptors.map((s) => {
            const meta = connectorMeta(s.id);
            return (
              <button
                key={s.id}
                type="button"
                className="as-tile"
                onClick={() => void pick(s.id)}
              >
                <span
                  className="as-ic"
                  style={{
                    color: `var(--tag-${meta.tag}, var(--accent-text))`,
                  }}
                >
                  <SourceIcon sourceId={s.id} size={24} />
                </span>
                <span className="as-nm">{sourceLabel(s.id, descriptors)}</span>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
