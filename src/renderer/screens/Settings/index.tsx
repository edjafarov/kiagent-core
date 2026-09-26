import React from 'react';
import { Account } from './Account';
import { Storage } from './Storage';
import { LocalProcessing } from './LocalProcessing';
import { Advanced } from './Advanced';
import { Extensions } from './Extensions';
import { About } from './About';
import { SettingsPage, type SettingsPaneDef } from './SettingsPage';

/**
 * Settings page panes. Panes print their own titles until each moves onto
 * the settings rows.
 */
const PANES: readonly SettingsPaneDef[] = [
  { key: 'account', label: 'Account', icon: 'user', render: () => <Account /> },
  {
    key: 'storage',
    label: 'Storage',
    icon: 'hard-drive',
    render: () => <Storage />,
  },
  {
    key: 'local',
    label: 'Local processing',
    icon: 'cpu',
    render: () => <LocalProcessing />,
  },
  {
    key: 'extensions',
    label: 'Extensions',
    icon: 'puzzle',
    render: () => <Extensions />,
  },
  {
    key: 'advanced',
    label: 'Advanced',
    icon: 'sliders',
    render: () => <Advanced />,
  },
  { key: 'about', label: 'About', icon: 'info', render: () => <About /> },
];

export function Settings(props: { pane?: string }): React.ReactElement {
  return <SettingsPage panes={PANES} pane={props.pane} />;
}
