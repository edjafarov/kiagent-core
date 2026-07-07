import React, { useEffect, useState } from 'react';
import type { Account } from '@shared/contracts';
import { Icon } from '@shared/web-ui/icon-sprite';
import { coveringRoots } from '@shared/folder-paths';
import { formatCount } from '@renderer/components/folder-picker/format-count';
import { FolderPickerModal } from '@renderer/components/folder-picker/FolderPickerModal';

/**
 * `config.paths` (string[]) as tracked by a local-folder account — the same
 * filter `AddSourcePanel` applies to derive `existingPaths` for the picker.
 * Exported so `SourceDetail` can decide whether to render this section at
 * all (only for accounts whose config actually carries a non-empty root
 * list) without duplicating the extraction logic.
 */
export function trackedFolderPaths(account: Account): string[] {
  const raw = account.config?.paths;
  return Array.isArray(raw)
    ? raw.filter((p): p is string => typeof p === 'string')
    : [];
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

/**
 * Per-root management for a local-folder account's `config.paths` — one row
 * per tracked root (full path + live recursive count) with a per-root Remove,
 * plus an "Add folders…" entry point into the same multi-select picker the
 * add flow uses (`AddSourcePanel`'s fast path). Rendered ABOVE `TrackedContent`
 * (which stays a flat, source-agnostic document browser) so folder-level
 * membership — the concept `Account`/`Document` have no notion of — gets its
 * own dedicated surface instead of being inferred from the document list.
 *
 * All config-mutating actions (remove, add) funnel through one
 * `accounts:update-config` call gated by `configPending`: every Remove
 * button and the Add button are disabled while a request is in flight, so a
 * user clicking Remove on a second root before the first root's removal has
 * round-tripped can't fire an overlapping `update-config` built from a config
 * snapshot that doesn't yet reflect the first removal (update-config replaces
 * `paths` wholesale, so two in-flight writes racing would let the loser
 * silently resurrect whatever the winner just dropped). The confirm dialog
 * itself unmounts synchronously on confirm, before the invoke resolves, so
 * the same root can't be double-submitted either.
 */
export function TrackedFolders(props: {
  account: Account;
}): React.ReactElement {
  const { account } = props;
  const paths = trackedFolderPaths(account);
  const pathsKey = paths.join('\0');

  const [counts, setCounts] = useState<Record<string, CountState>>({});
  const [confirmPath, setConfirmPath] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [configPending, setConfigPending] = useState(false);

  // Refetch every current root's count whenever the SET of roots changes
  // (add/remove) — keyed on the joined path list, not the `paths` array
  // reference, since `account` (and so `paths`) gets a fresh identity on
  // every app-state push (doc counts ticking, sync progress, …) even when
  // `config.paths` itself hasn't changed. Rebuilding `counts` from scratch
  // also means a removed root's stale count can never linger in state.
  useEffect(() => {
    let cancelled = false;
    setCounts(Object.fromEntries(paths.map((p) => [p, 'pending' as const])));
    for (const p of paths) {
      window.kiagent
        .invoke('sources:count-files', { path: p })
        .then((res) => {
          if (cancelled) return;
          setCounts((prev) => ({
            ...prev,
            [p]: res ? { count: res.count, capped: res.capped } : 'unavailable',
          }));
        })
        .catch(() => {
          if (!cancelled)
            setCounts((prev) => ({ ...prev, [p]: 'unavailable' }));
        });
    }
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refetch on the path SET (pathsKey), not on every `paths` array identity change
  }, [pathsKey]);

  async function applyPaths(nextPaths: string[]): Promise<void> {
    setConfigPending(true);
    try {
      await window.kiagent.invoke('accounts:update-config', {
        accountId: account.id,
        config: { ...account.config, paths: nextPaths },
      });
    } finally {
      setConfigPending(false);
    }
  }

  function handleRemove(path: string): void {
    setConfirmPath(null);
    void applyPaths(paths.filter((p) => p !== path));
  }

  function handleAdd(confirmed: string[]): void {
    setAdding(false);
    if (confirmed.length === 0) return;
    void applyPaths(coveringRoots([...paths, ...confirmed]));
  }

  const lastRoot = paths.length === 1;

  return (
    <section className="detail-card">
      <div className="lbl-section">Tracked folders</div>
      <ul className="tf-list">
        {paths.map((p) => (
          <li key={p} className="tf-row">
            <Icon
              name="folder"
              size={13}
              style={{ color: 'var(--text-secondary)' }}
            />
            <span className="tf-path mono" title={p}>
              {p}
            </span>
            <span className="t-meta tf-count">{countLabel(counts[p])}</span>
            <button
              type="button"
              className="btn ghost sm"
              disabled={lastRoot || configPending}
              title={lastRoot ? 'Remove the source instead' : undefined}
              onClick={() => setConfirmPath(p)}
            >
              <Icon name="trash" size={11} />
              Remove
            </button>
          </li>
        ))}
      </ul>
      <button
        type="button"
        className="btn sm"
        disabled={configPending}
        onClick={() => setAdding(true)}
      >
        <Icon name="plus" size={12} />
        Add folders…
      </button>

      {adding && (
        <FolderPickerModal
          multiSelect
          existingPaths={paths}
          onConfirm={handleAdd}
          onClose={() => setAdding(false)}
        />
      )}

      {confirmPath && (
        <RemoveFolderModal
          path={confirmPath}
          onCancel={() => setConfirmPath(null)}
          onConfirm={() => handleRemove(confirmPath)}
        />
      )}
    </section>
  );
}

/**
 * Confirm-remove dialog for a single tracked root — same modal chrome as
 * `RemoveAccountModal` (`ra-modal-*` classes: backdrop, Escape-to-cancel,
 * click-outside-to-cancel), scaled down to one exact confirmation line
 * rather than a title + detail paragraph, since dropping one root (unlike
 * `accounts:remove`) doesn't touch credentials/cursor/other roots.
 */
function RemoveFolderModal(props: {
  path: string;
  onCancel: () => void;
  onConfirm: () => void;
}): React.ReactElement {
  const { path, onCancel, onConfirm } = props;

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
        <div className="ra-modal-title mono">{path}</div>
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
