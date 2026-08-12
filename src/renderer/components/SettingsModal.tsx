import React, { useEffect } from 'react';
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

  return (
    <div
      className="kg-modal-backdrop"
      data-testid="settings-backdrop"
      onClick={onClose}
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
