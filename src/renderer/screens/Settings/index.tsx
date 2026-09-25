import React from 'react';
import { Account } from './Account';
import { Storage } from './Storage';
import { LocalProcessing } from './LocalProcessing';
import { Advanced } from './Advanced';
import { About } from './About';
import { SettingsPage, type SettingsPaneDef } from './SettingsPage';

/**
 * Settings page panes. Panes print their own titles until each moves onto
 * the settings rows.
 */
const PANES: readonly SettingsPaneDef[] = [
  { key: 'account', label: 'Account', render: () => <Account /> },
  { key: 'storage', label: 'Storage', render: () => <Storage /> },
  {
    key: 'local',
    label: 'Local processing',
    render: () => <LocalProcessing />,
  },
  { key: 'advanced', label: 'Advanced', render: () => <Advanced /> },
  { key: 'about', label: 'About', render: () => <About /> },
];

export function Settings(props: { pane?: string }): React.ReactElement {
  return <SettingsPage panes={PANES} pane={props.pane} />;
}
