import React, { useEffect, useState } from 'react';
import { FolderPickerModal } from './folder-picker/FolderPickerModal';
import { formatCount } from './folder-picker/format-count';

interface FolderPickerFieldProps {
  value: string;
  onChange: (path: string) => void;
}

type CountState =
  | { kind: 'idle' }
  | { kind: 'pending' }
  | { kind: 'result'; count: number; capped: boolean };

/**
 * Renderer for any connect() schema field tagged `format: 'folder-path'`
 * (AddSourcePanel keys off that, not the source id — any future source using
 * the format gets this for free). Generic: no local-folder-specific
 * knowledge beyond value/onChange and the underlying IPC calls.
 *
 * The free-text input stays editable — connect() still validates
 * server-side — alongside a "Choose…" button that opens the in-app
 * `FolderPickerModal` (a lazy folder tree with per-folder file counts,
 * ported from kiagent-ref) instead of a native OS dialog. Below the input, a
 * debounced (400ms) recursive file-count preview keyed off `value`, using
 * the SAME enumeration rules the local-folder source scans with (see
 * scanner.ts's countFiles), so the number can never drift from what
 * adding the folder would actually index.
 */
export function FolderPickerField(
  props: FolderPickerFieldProps,
): React.ReactElement {
  const { value, onChange } = props;
  const [countState, setCountState] = useState<CountState>({ kind: 'idle' });
  const [pickerOpen, setPickerOpen] = useState(false);

  // Debounced, stale-response-safe count preview. `cancelled` is flipped by
  // the cleanup function whenever `value` changes again (a newer request
  // superseding an older one) AND on unmount — either way, no setState fires
  // for a response that's no longer the latest word.
  useEffect(() => {
    if (value.trim().length === 0) {
      setCountState({ kind: 'idle' });
      return undefined;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      setCountState({ kind: 'pending' });
      window.kiagent
        .invoke('sources:count-files', { path: value })
        .then((res) => {
          if (cancelled) return;
          setCountState(
            res
              ? { kind: 'result', count: res.count, capped: res.capped }
              : { kind: 'idle' },
          );
        })
        .catch(() => {
          if (!cancelled) setCountState({ kind: 'idle' });
        });
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [value]);

  return (
    <div>
      <div className="row-flex">
        <input
          className="input"
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
        <button
          type="button"
          className="btn sm"
          onClick={() => setPickerOpen(true)}
        >
          Choose…
        </button>
      </div>
      {countState.kind === 'pending' && <div className="t-meta">counting…</div>}
      {countState.kind === 'result' && (
        <div className="t-meta">
          {formatCount(countState.count, countState.capped)}
        </div>
      )}
      {pickerOpen && (
        <FolderPickerModal
          onConfirm={(paths) => {
            if (paths[0] !== undefined) onChange(paths[0]);
          }}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </div>
  );
}
