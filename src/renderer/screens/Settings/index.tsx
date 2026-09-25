import React from 'react';
import { SettingsLayout } from '@shared/web-ui/ui';
import { useView } from '@renderer/state/view';
import { Account } from './Account';
import { Storage } from './Storage';
import { LocalProcessing } from './LocalProcessing';
import { Advanced } from './Advanced';
import { About } from './About';
import './Settings.css';

/**
 * Settings page: a pane list and the selected pane. The pane is part of the
 * route (`params.pane`), so leaving Settings and coming back returns to it.
 * Panes print their own titles until each moves onto the settings rows.
 */

const ITEMS = [
  { key: 'account', label: 'Account' },
  { key: 'storage', label: 'Storage' },
  { key: 'local', label: 'Local processing' },
  { key: 'advanced', label: 'Advanced' },
  { key: 'about', label: 'About' },
] as const;

type SettingsKey = (typeof ITEMS)[number]['key'];

function isKey(v: string | undefined): v is SettingsKey {
  return ITEMS.some((i) => i.key === v);
}

export function Settings(props: { pane?: string }): React.ReactElement {
  const { replaceParams } = useView();
  // The route is the one source of the pane; a switch rewrites the route.
  const selected: SettingsKey = isKey(props.pane) ? props.pane : 'account';

  const select = (key: string): void => {
    if (isKey(key)) replaceParams({ pane: key });
  };

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
    <SettingsLayout panes={ITEMS} active={selected} onSelect={select}>
      {pane}
    </SettingsLayout>
  );
}
