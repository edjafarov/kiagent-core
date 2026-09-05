import React, { useEffect, useMemo, useRef, useState } from 'react';
import type {
  Account,
  FolderNode,
  FolderRootSelection,
} from '@shared/contracts';
import type { ConnectEvent } from '@shared/ipc';
import { Icon } from '@shared/web-ui/icon-sprite';
import { formatCount } from '@renderer/components/folder-picker/format-count';
import { FolderPickerModal } from '@renderer/components/folder-picker/FolderPickerModal';
import {
  createConnectPickerAdapter,
  pickerRequestFromEvent,
  type PickerRequest,
} from '../connect-picker-adapter';
import { openFlow } from '../flow-client';

/**
 * The canonical folder scope of ANY folder-scoped source — `config.folderRoots`
 * (`FolderRootSelection[]`), written by the v3 migration and by every
 * `applyFolderScope` commit. Replaces the old `trackedFolderPaths`, which read
 * the local-folder-only `config.paths`. Legacy mirrors (`paths` for
 * local-folder, `roots` for the cloud connectors) are deliberately NOT read
 * here: core owns them (A-2) and they exist for one release train so an
 * un-updated installed connector keeps working (R1). The renderer must never
 * make them load-bearing.
 *
 * `name` is display-only; a root is identified by `id` alone. An entry whose
 * `id` is missing or empty is dropped rather than rendered as a nameless row a
 * user could Remove; a missing `name` falls back to the id so a partially
 * migrated config still renders something addressable.
 */
export function folderRoots(account: Account): FolderRootSelection[] {
  const raw = account.config?.folderRoots;
  if (!Array.isArray(raw)) return [];
  const out: FolderRootSelection[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { id, name } = entry as { id?: unknown; name?: unknown };
    if (typeof id !== 'string' || id === '') continue;
    out.push({
      id,
      name: typeof name === 'string' && name !== '' ? name : id,
    });
  }
  return out;
}

/** `FolderRootSelection.id` is an absolute normalized filesystem path for
 *  local-folder (B-7: `config.paths[i]` verbatim) and an opaque provider item
 *  id for Drive/OneDrive. Only the former can be counted: `sources:count-files`
 *  is a local-filesystem channel (`main.ts:404-413` resolves + stats the path).
 *  A cloud root therefore renders NO count in v1 — inventing a per-root cloud
 *  count channel is out of scope, and letting the row flash "counting…" before
 *  an inevitable stat failure is a lie. Shape-based rather than
 *  `account.source`-based so this card stays source-agnostic, which is the
 *  whole point of `folderScope`. */
const ABSOLUTE_PATH = /^(?:\/|[A-Za-z]:[\\/])/;
export function isLocalPathRoot(id: string): boolean {
  return ABSOLUTE_PATH.test(id);
}

type CountState =
  | 'pending'
  | 'unavailable'
  | { count: number; capped: boolean };

function countLabel(state: CountState | undefined): string | null {
  if (state === undefined || state === 'pending') return 'counting…';
  if (state === 'unavailable') return null;
  return formatCount(state.count, state.capped);
}

/** The `folder-picker` event's payload in the exact shape A-6 pins for
 *  `createConnectPickerAdapter`. Imported rather than re-declared so a drift
 *  in Task 5's parameter type is a compile error, not a silent structural
 *  mismatch; narrowed here because Task 7's ConnectEvent makes all three
 *  fields required on the wire. */
type PickerState = PickerRequest & {
  multiSelect: boolean;
  selected: FolderNode[];
  purpose: 'connect' | 'manage';
};

interface ManageFlow {
  flowId: string | null;
  status?: string;
  picker: PickerState | null;
  /** Non-null when this flow was started by a row's Remove: the picker event
   *  is auto-confirmed with the remaining set and the modal never shows. */
  removeId: string | null;
  /** A confirm is in flight main-side. A ref can't drive a render, so this
   *  lives in state. */
  saving: boolean;
}

/**
 * The shared **Manage folders** surface for every folder-scoped source —
 * one row per canonical `config.folderRoots` entry, with a per-root Remove and
 * a `Manage folders…` entry point into the account-scoped folder-scope flow.
 * Rendered by `SourceDetail` whenever the account's `SourceDescriptor` carries
 * `folderScope: true` (never on config shape, which is what limited this card
 * to local-folder before).
 *
 * There is NO renderer-side `accounts:update-config` path for folder roots any
 * more. Every mutation — the modal's Save and the per-row Remove shortcut
 * alike — submits the SAME complete covering set through one
 * `accounts:start-manage-folders` flow, so the source computes the archive
 * instruction and core commits config + cursor + archival in one transaction.
 *
 * A `needsReauth` account renders read-only: `manageFolders` browses the
 * provider with the account's existing credentials, so neither Manage nor the
 * Remove shortcut can run without them (R4). `SourceDetail`'s topbar carries
 * the Reconnect button; this card only explains why the controls are inert.
 */
export function TrackedFolders(props: {
  account: Account;
}): React.ReactElement {
  const { account } = props;
  const roots = folderRoots(account);
  const rootsKey = roots.map((r) => r.id).join('\0');
  const needsReauth = account.status === 'needsReauth';

  const [counts, setCounts] = useState<Record<string, CountState>>({});
  // Written by each row's Remove; read by the confirm dialog Step 11 mounts.
  const [confirmId, setConfirmId] = useState<string | null>(null);

  const [flow, setFlow] = useState<ManageFlow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<{ added: number; removed: number } | null>(
    null,
  );

  // Refetch every LOCAL root's count whenever the SET of roots changes — keyed
  // on the joined id list, not the `roots` array reference, since `account`
  // gets a fresh identity on every app-state push even when the config didn't
  // change. Cloud roots are skipped entirely (see isLocalPathRoot).
  useEffect(() => {
    let cancelled = false;
    const local = roots.filter((r) => isLocalPathRoot(r.id));
    setCounts(Object.fromEntries(local.map((r) => [r.id, 'pending' as const])));
    for (const r of local) {
      window.kiagent
        .invoke('sources:count-files', { path: r.id })
        .then((res) => {
          if (cancelled) return;
          setCounts((prev) => ({
            ...prev,
            [r.id]: res
              ? { count: res.count, capped: res.capped }
              : 'unavailable',
          }));
        })
        .catch(() => {
          if (!cancelled)
            setCounts((prev) => ({ ...prev, [r.id]: 'unavailable' }));
        });
    }
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refetch on the root SET (rootsKey), not on every `roots` array identity change
  }, [rootsKey]);

  const unsubscribeRef = useRef<(() => void) | null>(null);
  const liveFlowRef = useRef<string | null>(null);
  // Set the moment a cancel is issued: connect-broker.ts:166-168 answers a
  // cancelled flow with {kind:'error', msg:'connect flow cancelled'}, and
  // rendering that as "Couldn’t update tracked folders: connect flow
  // cancelled" would turn the spec's "Cancel with no mutation" into a fake
  // failure. Every later event for this flow is dropped instead.
  const cancelledRef = useRef(false);
  // Set once a picker confirm is in flight: the save is now main-side and must
  // be allowed to land, so teardown must NOT cancel this flow.
  const savingRef = useRef(false);

  async function startManage(removeId: string | null): Promise<void> {
    if (flow) return; // one folder-scope flow per card at a time
    setError(null);
    setSaved(null);
    cancelledRef.current = false;
    savingRef.current = false;
    setFlow({ flowId: null, picker: null, removeId, saving: false });

    const applyEvent = (evt: ConnectEvent): void => {
      if (cancelledRef.current) return;
      if (evt.kind === 'scope-saved') {
        endSubscription();
        setSaved({ added: evt.added, removed: evt.removed });
        setFlow(null);
        return;
      }
      if (evt.kind === 'error') {
        // Decision 9: Task 7 settles the flow before sending this, so there is
        // nothing left to keep a modal open over. Surface it and re-arm.
        endSubscription();
        setError(evt.msg);
        setFlow(null);
        return;
      }
      setFlow((prev) => {
        if (!prev) return prev;
        switch (evt.kind) {
          case 'status':
            return { ...prev, status: evt.msg };
          case 'folder-picker':
            return { ...prev, picker: pickerRequestFromEvent(evt) };
          default:
            return prev;
        }
      });
    };

    try {
      await openFlow(
        () =>
          window.kiagent.invoke('accounts:start-manage-folders', {
            accountId: account.id,
          }),
        applyEvent,
        {
          onSubscribed: (unsubscribe) => {
            unsubscribeRef.current = unsubscribe;
          },
          onFlowId: (flowId) => {
            liveFlowRef.current = flowId;
            setFlow((prev) => (prev ? { ...prev, flowId } : prev));
          },
        },
      );
    } catch (err) {
      // openFlow already unsubscribed on its own throw path.
      unsubscribeRef.current = null;
      liveFlowRef.current = null;
      setError(err instanceof Error ? err.message : String(err));
      setFlow(null);
    }
  }

  function endSubscription(): void {
    unsubscribeRef.current?.();
    unsubscribeRef.current = null;
    liveFlowRef.current = null;
  }

  const busy = flow !== null;
  const lastRoot = roots.length === 1;

  const picker = flow?.picker ?? null;
  // Rebuilt only when a new event object (new requestId) lands, so its
  // id→FolderNode map survives re-renders while the modal is open.
  const pickerAdapter = useMemo(
    () => (picker ? createConnectPickerAdapter(picker) : null),
    [picker],
  );
  // The modal fires onClose right after onConfirm; only an UNconfirmed close
  // may cancel the flow's pending pickFolders.
  const pickerConfirmedForRef = useRef<string | null>(null);

  // Everything the teardown needs, held in refs so the unmount path never
  // touches state. A confirmed picker's flow is deliberately NOT cancelled:
  // its transaction is already main-side and must be allowed to commit.
  const teardownRef = useRef<() => void>(() => {});
  teardownRef.current = () => {
    cancelledRef.current = true;
    const open =
      picker &&
      pickerAdapter &&
      pickerConfirmedForRef.current !== picker.requestId
        ? pickerAdapter
        : null;
    const flowId = liveFlowRef.current;
    endSubscription();
    if (open) void open.cancel().catch(() => {});
    if (flowId && !savingRef.current)
      void window.kiagent
        .invoke('accounts:cancel-flow', { flowId })
        .catch(() => {});
  };

  useEffect(
    () => () => teardownRef.current(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  function cancelManage(): void {
    teardownRef.current();
    setFlow(null);
  }

  // The Remove shortcut: as soon as the flow's picker event lands, confirm the
  // COMPLETE remaining covering set — the identical command the modal's Save
  // submits — and never show the modal. Refuses to submit a set that would be
  // empty (R3: an account may not exist with zero roots) or that is unchanged
  // (the source no longer reports this root, so the renderer's row is stale) —
  // cancelling is the only safe answer, since an empty or no-op confirm would
  // either fail validation main-side or burn a flow for nothing.
  useEffect(() => {
    const removeId = flow?.removeId ?? null;
    if (!picker || !pickerAdapter || removeId === null) return;
    const remaining = picker.selected.filter((n) => n.id !== removeId);
    if (remaining.length === 0 || remaining.length === picker.selected.length) {
      cancelManage();
      return;
    }
    pickerConfirmedForRef.current = picker.requestId;
    savingRef.current = true;
    void pickerAdapter.confirm(remaining.map((n) => n.id)).catch((err) => {
      setError(err instanceof Error ? err.message : String(err));
    });
    setFlow((prev) => (prev ? { ...prev, picker: null, saving: true } : prev));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picker, pickerAdapter, flow?.removeId]);

  return (
    <section className="detail-card">
      <div className="lbl-section">Tracked folders</div>
      {roots.length === 0 ? (
        <div className="t-meta">No folders selected yet.</div>
      ) : (
        <ul className="tf-list">
          {roots.map((r) => (
            <li key={r.id} className="tf-row">
              <Icon
                name="folder"
                size={13}
                style={{ color: 'var(--text-secondary)' }}
              />
              <span className="tf-name">{r.name}</span>
              <span className="tf-path mono" title={r.id}>
                {r.id === r.name ? '' : r.id}
              </span>
              <span className="t-meta tf-count">
                {isLocalPathRoot(r.id) ? countLabel(counts[r.id]) : null}
              </span>
              <button
                type="button"
                className="btn ghost sm"
                disabled={lastRoot || busy || needsReauth}
                title={
                  lastRoot
                    ? 'Remove this source to stop tracking its last folder.'
                    : undefined
                }
                onClick={() => setConfirmId(r.id)}
              >
                <Icon name="trash" size={11} />
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}

      {needsReauth ? (
        <div className="t-meta">
          Reconnect this source to change its tracked folders.
        </div>
      ) : (
        <button
          type="button"
          className="btn sm"
          disabled={busy}
          onClick={() => void startManage(null)}
        >
          <Icon name="folder" size={12} />
          Manage folders…
        </button>
      )}

      {busy && !flow?.picker && (
        <div className="t-meta">
          {flow?.saving ? 'Saving…' : (flow?.status ?? 'Opening folder list…')}
        </div>
      )}
      {error && (
        <div className="si-error">Couldn’t update tracked folders: {error}</div>
      )}
      {saved && (
        <div className="t-meta">
          Folders updated — {saved.added} added, {saved.removed} removed.
        </div>
      )}

      {picker && pickerAdapter && flow?.removeId === null && (
        <FolderPickerModal
          key={picker.requestId}
          multiSelect={picker.multiSelect}
          dataSource={pickerAdapter.dataSource}
          selected={pickerAdapter.selected}
          expandIds={pickerAdapter.expandIds}
          purpose={picker.purpose}
          onConfirm={(ids) => {
            pickerConfirmedForRef.current = picker.requestId;
            savingRef.current = true;
            void pickerAdapter.confirm(ids).catch((err) => {
              setError(err instanceof Error ? err.message : String(err));
            });
            setFlow((prev) =>
              prev ? { ...prev, picker: null, saving: true } : prev,
            );
          }}
          onClose={() => {
            if (pickerConfirmedForRef.current !== picker.requestId)
              cancelManage();
          }}
        />
      )}

      {confirmId !== null && (
        <RemoveFolderModal
          root={
            roots.find((r) => r.id === confirmId) ?? {
              id: confirmId,
              name: confirmId,
            }
          }
          onCancel={() => setConfirmId(null)}
          onConfirm={() => {
            setConfirmId(null);
            void startManage(confirmId);
          }}
        />
      )}
    </section>
  );
}

/**
 * Confirm-remove dialog for a single tracked root — same modal chrome as
 * `RemoveAccountModal` (`ra-modal-*`: backdrop, Escape-to-cancel,
 * click-outside-to-cancel). Keyed by `FolderRootSelection` rather than a path
 * so it names a cloud root by its display name, with the opaque id shown only
 * when it differs.
 */
function RemoveFolderModal(props: {
  root: FolderRootSelection;
  onCancel: () => void;
  onConfirm: () => void;
}): React.ReactElement {
  const { root, onCancel, onConfirm } = props;

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Stop tracking folder"
      onClick={onCancel}
      className="ra-modal-backdrop"
    >
      <div onClick={(e) => e.stopPropagation()} className="tray-pop ra-modal">
        <div className="ra-modal-title mono">
          {root.id === root.name ? root.id : `${root.name} — ${root.id}`}
        </div>
        <div className="ra-modal-body">
          Stop tracking this folder? Its files will be removed from search.
        </div>
        <div className="ra-modal-actions">
          <button
            type="button"
            className="btn destructive sm"
            style={{ justifyContent: 'flex-start' }}
            onClick={onConfirm}
          >
            <Icon name="trash" size={12} />
            Remove
          </button>
          <button
            type="button"
            className="btn ghost sm"
            style={{ justifyContent: 'flex-start' }}
            onClick={onCancel}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
