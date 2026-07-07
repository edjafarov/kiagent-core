import React, { useState } from 'react';
import { Account } from './Account';
import { Storage } from './Storage';
import { LocalProcessing } from './LocalProcessing';
import { Advanced } from './Advanced';
import { About } from './About';
import './Settings.css';

/**
 * 5-pane settings shell (ui-inventory.md §2.9), matching the legacy
 * `SettingsShell` layout: a violet `.set-sidebar` nav + scrollable
 * `.set-pane`. `View` only has a single top-level `'settings'` entry (see
 * state/view.ts) — pane selection is in-screen local state, not routed.
 */

const ITEMS = [
  { key: 'account', label: 'Account' },
  { key: 'storage', label: 'Storage' },
  { key: 'local', label: 'Local processing' },
  { key: 'advanced', label: 'Advanced' },
  { key: 'about', label: 'About' },
] as const;

type SettingsKey = (typeof ITEMS)[number]['key'];

export function Settings(): React.ReactElement {
  const [selected, setSelected] = useState<SettingsKey>('account');

  const pane =
    selected === 'account' ? (
      <Account />
    ) : selected === 'storage' ? (
      <Storage />
    ) : selected === 'local' ? (
      <LocalProcessing />
    ) : selected === 'advanced' ? (
      <Advanced />
    ) : (
      <About />
    );

  return (
    <div className="set-shell">
      <div className="set-sidebar">
        <div className="lbl-section">Settings</div>
        {ITEMS.map((item) => (
          <button
            key={item.key}
            type="button"
            className={`side-item${selected === item.key ? ' active' : ''}`}
            onClick={() => setSelected(item.key)}
          >
            {item.label}
          </button>
        ))}
      </div>
      <div className="set-pane">{pane}</div>
    </div>
  );
}
