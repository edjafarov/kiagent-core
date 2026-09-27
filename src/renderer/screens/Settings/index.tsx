import React from 'react';
import { SettingsPage } from './SettingsPage';
import { CORE_PANES } from './panes';

export function Settings(props: { pane?: string }): React.ReactElement {
  return <SettingsPage panes={CORE_PANES} pane={props.pane} />;
}
