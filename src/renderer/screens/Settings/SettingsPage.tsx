import React from 'react';
import { SettingsLayout } from '@shared/web-ui/ui';
import { useView } from '@renderer/state/view';
import './Settings.css';

/** One Settings pane: its nav entry and what it shows. */
export interface SettingsPaneDef {
  key: string;
  label: string;
  render: () => React.ReactNode;
}

/**
 * The routed Settings page, shared by both builds (not shadowed; each
 * build's `Settings` passes its own pane list). The pane is part of the
 * route (`params.pane`), so leaving Settings and coming back returns to it;
 * a pane the list does not have shows the first one.
 */
export function SettingsPage(props: {
  panes: readonly SettingsPaneDef[];
  pane?: string;
}): React.ReactElement {
  const { replaceParams } = useView();
  const active =
    props.panes.find((p) => p.key === props.pane) ?? props.panes[0];
  return (
    <SettingsLayout
      panes={props.panes}
      active={active.key}
      onSelect={(key) => replaceParams({ pane: key })}
    >
      {active.render()}
    </SettingsLayout>
  );
}
