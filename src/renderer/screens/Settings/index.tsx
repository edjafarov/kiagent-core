import React from 'react';
import { General } from './General';
import { Account } from './Account';
import { Storage } from './Storage';
import { LocalProcessing } from './LocalProcessing';
import { Extensions } from './Extensions';
import { About } from './About';
import { SettingsPage, type SettingsPaneDef } from './SettingsPage';

/** Settings page panes. A pane key is part of the route, so keys never
 *  change once shipped (`local` is labelled Local AI). */
const PANES: readonly SettingsPaneDef[] = [
  {
    key: 'general',
    label: 'General',
    icon: 'sliders',
    render: () => <General />,
  },
  { key: 'account', label: 'Account', icon: 'user', render: () => <Account /> },
  {
    key: 'local',
    label: 'Local AI',
    icon: 'cpu',
    render: () => <LocalProcessing />,
  },
  {
    key: 'storage',
    label: 'Storage',
    icon: 'hard-drive',
    render: () => <Storage />,
  },
  {
    key: 'extensions',
    label: 'Extensions',
    icon: 'puzzle',
    ownTitle: true,
    render: () => <Extensions />,
  },
  { key: 'about', label: 'About', icon: 'info', render: () => <About /> },
];

export function Settings(props: { pane?: string }): React.ReactElement {
  return <SettingsPage panes={PANES} pane={props.pane} />;
}
