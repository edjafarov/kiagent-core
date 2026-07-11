import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { ConnectEvent } from '@shared/ipc';
import type { Account, AccountId } from '@shared/contracts';
import { coveringRoots } from '@shared/folder-paths';
import { Icon } from '@shared/web-ui/icon-sprite';
import { useAppState } from '@renderer/state/app-state';
import { FolderPickerField } from '@renderer/components/FolderPickerField';
import { FolderPickerModal } from '@renderer/components/folder-picker/FolderPickerModal';
import { connectorMeta, sourceLabel } from './connector-meta';
import { createConnectPickerAdapter } from './connect-picker-adapter';
import { schemaFields, schemaGuidance } from './prompt-guidance';
import { GuidanceSteps } from './GuidanceSteps';
import { SourceIcon } from './SourceIcon';
import { useSourceDescriptors } from './sources-registry';

/**
 * In-place "add a source" panel — swapped in over the Sources body, matching
 * the legacy AddSource screen's non-modal tile-grid + wizard (ui-inventory.md
 * §2.7, docs/screens/add-source.html). A tile per registered `SourceDescriptor`
 * (icon + label from connector-meta.ts), then `accounts:add` + a `push:connect`
 * listener rendering whatever the flow sends: a status line, a QR code, a
 * schema-driven prompt form, done, or error. A schema with exactly one
 * `folder-paths` (array) field (local-folder) skips the form for the in-app
 * multi-select folder picker instead, confirming the whole selection as ONE
 * prompt answer (see `submitFolderPaths` below) — connect()'s upsert then
 * folds it into the single machine account. Every other schema keeps the
 * classic form, which still renders `FolderPickerField` for a singular
 * `folder-path` field. Flow states render as a centered wizard card; guidance
 * steps come from the schema's x-steps (prompt-guidance.ts).
 */

interface FlowState {
  flowId: string;
  sourceId: string;
  status?: string;
  qr?: string;
  prompt?: { requestId: string; schema: unknown };
  /** An AuthChannel.pickFolders in progress — renders FolderPickerModal over
   *  a source-served tree (see connect-picker-adapter.ts). */
  picker?: {
    requestId: string;
    multiSelect: boolean;
    modes: Array<{ key: string; label: string }>;
  };
  error?: string;
  done?: Account;
}

/**
 * Starts a connect flow and forwards its events to `onEvent`. Subscribes to
 * push:connect BEFORE invoking accounts:add: a source that prompts
 * immediately (local-folder) emits its first event before the invoke's
 * response tells us the flowId — in fact the flow's connect() typically runs
 * synchronously far enough to call auth.prompt() before accounts:add's own
 * response reaches the renderer, so this is the COMMON case, not a rare race.
 * Events arriving before the flowId is known are buffered here and replayed
 * once it is. Two optional hooks let a caller that keeps its own state in
 * sync with the flow (`pick()` below, via `flow`/`applyEvent`) do so at
 * exactly the right moments rather than after the fact:
 *  - `onSubscribed` fires synchronously, before the accounts:add invoke, so
 *    the caller can record `unsubscribe` immediately (matching this
 *    function's own subscribe-before-invoke ordering).
 *  - `onFlowId` fires the instant the flowId is known, BEFORE the buffered
 *    replay — `pick()`'s `applyEvent` is a no-op until `flow` state exists,
 *    so replayed events (which for local-folder is almost always the
 *    prompt) would otherwise be silently dropped.
 */
async function openFlow(
  sourceId: string,
  onEvent: (evt: ConnectEvent) => void,
  hooks?: {
    onSubscribed?: (unsubscribe: () => void) => void;
    onFlowId?: (flowId: string) => void;
  },
): Promise<{ flowId: string; unsubscribe: () => void }> {
  let flowId: string | null = null;
  const buffered: ConnectEvent[] = [];
  const unsubscribe = window.kiagent.on('push:connect', (evt) => {
    if (flowId === null) {
      buffered.push(evt);
      return;
    }
    if (evt.flowId !== flowId) return; // another window/flow's event
    onEvent(evt);
  });
  hooks?.onSubscribed?.(unsubscribe);
  try {
    const res = await window.kiagent.invoke('accounts:add', { sourceId });
    flowId = res.flowId;
    hooks?.onFlowId?.(flowId);
    for (const evt of buffered) {
      if (evt.flowId === flowId) onEvent(evt);
    }
    buffered.length = 0;
    return { flowId, unsubscribe };
  } catch (err) {
    unsubscribe();
    throw err;
  }
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
}): React.ReactElement {
  const descriptors = useSourceDescriptors();
  // Every account currently in the app-state projection — read unconditionally
  // (Rules of Hooks: this component has an early `if (flow)` return below) so
  // `existingPaths`, computed further down from `flow.sourceId`, always
  // reflects the CURRENT projection rather than a snapshot from whenever the
  // fast-path picker first opened.
  const accountEntries = useAppState((s) => s.accounts);
  const [flow, setFlow] = useState<FlowState | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [addError, setAddError] = useState<string | null>(null);
  const unsubscribeRef = useRef<(() => void) | null>(null);
  // Set once the folder picker's "Add N folders" has fired for the current
  // flow — distinguishes a dismiss-with-nothing-confirmed (reuse the panel's
  // Cancel semantics) from the modal's own onClose-right-after-onConfirm.
  const confirmedRef = useRef(false);

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
  liveFlowRef.current = flow && !flow.done && !flow.error ? flow.flowId : null;

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

  // Roots the CURRENT flow's source already tracks under an existing account
  // (the local-folder machine account's `config.paths`) — recomputed every
  // render from `accountEntries`/`flow.sourceId`, so both the picker's
  // `tracked` pills and `submitFolderPaths`'s union always see the latest
  // app-state, never a value captured when the picker first opened.
  const existingPaths: string[] = flow
    ? accountEntries
        .filter((e) => e.account.source === flow.sourceId)
        .flatMap((e) => {
          const raw = e.account.config?.paths;
          return Array.isArray(raw)
            ? raw.filter((p): p is string => typeof p === 'string')
            : [];
        })
    : [];

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

  async function pick(sourceId: string): Promise<void> {
    setAddError(null);
    confirmedRef.current = false;

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
      await openFlow(sourceId, applyEvent, {
        onSubscribed: (unsubscribe) => {
          unsubscribeRef.current = unsubscribe;
        },
        onFlowId: (flowId) => setFlow({ flowId, sourceId }),
      });
    } catch (err) {
      // openFlow already unsubscribed on its own throw path; drop our
      // reference too so a later unmount doesn't call it again.
      unsubscribeRef.current = null;
      setAddError(err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * Confirms the folder picker's multi-select choice as ONE prompt answer:
   * the union of the just-confirmed covering roots and whatever roots this
   * machine already tracks (`existingPaths`, read from the CURRENT app-state
   * projection via `accountEntries` above — never a stale closure), collapsed
   * back down to a minimal covering set via the shared `coveringRoots` so the
   * upserted local-folder account's config never loses an already-tracked
   * folder. Answers the ALREADY-OPEN flow's prompt (the one `pick()` started
   * and whose prompt triggered the fast-path picker) — built explicitly from
   * the confirmed paths rather than through `answers` state, which the
   * Submit button populates and which the picker bypasses entirely, so it may
   * hold nothing for this field. The done/error views below react to this
   * flow's own push:connect events exactly as they do for the classic form —
   * no separate outcome-tracking is needed for a single flow.
   */
  async function submitFolderPaths(paths: string[]): Promise<void> {
    if (paths.length === 0 || !flow?.prompt) return;
    const { requestId } = flow.prompt;
    const key = schemaFields(flow.prompt.schema).find(
      (f) => f.folderPaths,
    )?.key;
    if (!key) return; // fast-path guard already ensured exactly one folder-paths field

    const union = coveringRoots([...paths, ...existingPaths]);
    await window.kiagent.invoke('accounts:prompt-answer', {
      requestId,
      answers: { [key]: union },
    });
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
    const folderPathsPrompt =
      promptFields !== null &&
      promptFields.length === 1 &&
      promptFields[0].folderPaths;

    // Modal branches render outside the wizard card (they overlay the app).
    if (picker && pickerAdapter) {
      return (
        // AuthChannel.pickFolders — the same modal, served by the SOURCE's
        // tree callbacks over the accounts:picker-* invokes. Confirm maps
        // the synthetic paths back to FolderNodes and resolves the flow's
        // pending pickFolders; an unconfirmed close cancels it (connect()
        // throws, the flow's own error event renders below).
        <FolderPickerModal
          key={picker.requestId}
          multiSelect={picker.multiSelect}
          dataSource={pickerAdapter.dataSource}
          onConfirm={(paths) => {
            pickerConfirmedForRef.current = picker.requestId;
            // A confirm racing a flow that already settled (extension
            // crash) rejects with "unknown picker request"; the flow's own
            // error event is what the user sees — just log it.
            void pickerAdapter.confirm(paths).catch((err) => {
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
    if (flow.prompt && folderPathsPrompt) {
      return (
        // Exactly one `folder-paths` (array) field — skip the classic form
        // entirely and open the multi-select picker directly (no
        // "Choose…" step); a multi-field schema (Gmail, IMAP, or a
        // singular folder-path field alongside others) always falls
        // through to the wizard card below, which renders
        // FolderPickerField for any singular folder-path field it contains.
        <FolderPickerModal
          multiSelect
          existingPaths={existingPaths}
          onConfirm={(paths) => {
            confirmedRef.current = true;
            void submitFolderPaths(paths);
          }}
          onClose={() => {
            if (!confirmedRef.current) props.onDone();
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
              Connect {sourceLabel(flow.sourceId, descriptors)}
            </span>
          </div>

          {flow.done ? (
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
