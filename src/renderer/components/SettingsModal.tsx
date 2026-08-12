import React, { useEffect, useRef } from 'react';
import { Settings } from '@renderer/screens/Settings';
import { Icon } from '@shared/web-ui/icon-sprite';
import './SettingsModal.css';

/** ChatGPT-style settings dialog (spec §6): centered over the current view,
 *  never routed — closing restores whatever the user was doing untouched. */
export function SettingsModal(props: {
  onClose: () => void;
}): React.ReactElement {
  const { onClose } = props;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  /* A `click` fires on the nearest common ancestor of the mousedown and
     mouseup targets, so selecting text inside the dialog and releasing the
     button over the backdrop lands a click ON the backdrop — a
     `target === currentTarget` test can't tell that apart from a real
     backdrop click. Remember where the press began and dismiss only then. */
  const pressStartedOnBackdrop = useRef(false);

  function onBackdropMouseDown(e: React.MouseEvent): void {
    pressStartedOnBackdrop.current = e.target === e.currentTarget;
  }
  function onBackdropClick(): void {
    const dismiss = pressStartedOnBackdrop.current;
    pressStartedOnBackdrop.current = false;
    if (dismiss) onClose();
  }

  return (
    <div
      className="kg-modal-backdrop"
      data-testid="settings-backdrop"
      onMouseDown={onBackdropMouseDown}
      onClick={onBackdropClick}
      role="presentation"
    >
      <div
        className="kg-settings-modal"
        role="dialog"
        aria-label="Settings"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="kg-settings-modal-title">
          <h2>Settings</h2>
          <button type="button" aria-label="Close settings" onClick={onClose}>
            <Icon name="x" size={14} />
          </button>
        </div>
        <div className="kg-settings-modal-body">
          <Settings />
        </div>
      </div>
    </div>
  );
}
