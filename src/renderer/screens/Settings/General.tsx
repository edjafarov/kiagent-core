import React, { useEffect, useState } from 'react';
import { useAppState } from '@renderer/state/app-state';
import { useView } from '@renderer/state/view';
import {
  Button,
  Disclosure,
  ProgressBar,
  Select,
  SettingsGroup,
  SettingsRow,
  TextButton,
  Toggle,
  clockTime,
  computerNoun,
  dayGroup,
  dayMonth,
} from '@shared/web-ui/ui';
import type { AppPrefs, LogLevel } from '@shared/contracts';
import type { UpdateState } from '@shared/ipc';
import { DEFAULT_PRODUCT_NAME } from '@shared/product';

const LOG_LEVELS: ReadonlyArray<[LogLevel, string]> = [
  ['info', 'Info'],
  ['warn', 'Warnings'],
  ['error', 'Errors'],
];

/** When the last check finished, e.g. "today at 09:12" or "3 Sep". */
function checkedWhen(at: number, now: number): string {
  const group = dayGroup(at, now);
  if (group === 'Today') return `today at ${clockTime(at)}`;
  if (group === 'Yesterday') return `yesterday at ${clockTime(at)}`;
  return dayMonth(at);
}

/** The one line the updater's state earns. Covers the whole
 *  `UpdateStatus` union. */
export function updateLine(u: UpdateState | null, now: number): string {
  switch (u?.status) {
    case 'checking':
      return 'Checking for updates…';
    case 'available':
      return `Update available${u.version ? ` (${u.version})` : ''}, downloading…`;
    case 'downloading':
      return `Downloading${u.version ? ` ${u.version}` : ''}${
        typeof u.percent === 'number' ? ` · ${Math.round(u.percent)}%` : '…'
      }`;
    case 'downloaded':
      return `${u.version ?? 'An update'} is ready — restart to finish.`;
    case 'error':
      return `Update check failed: ${u.error ?? 'unknown error'}`;
    case 'disabled':
      return u.reason === 'dev'
        ? 'Updates are disabled in development.'
        : u.reason === 'unsigned-macos'
          ? 'Automatic updates are not yet available on macOS.'
          : 'Updates are disabled.';
    case 'up-to-date':
    case 'idle':
    default:
      return u?.checkedAt != null
        ? `Checked ${checkedWhen(u.checkedAt, now)}`
        : 'You’re up to date.';
  }
}

/** The updater, read once and then followed on `push:update-state`. */
function useUpdates(): {
  update: UpdateState | null;
  check: () => void;
  checking: boolean;
} {
  const [update, setUpdate] = useState<UpdateState | null>(null);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    void window.kiagent
      .invoke('update:get-state', undefined)
      .then(setUpdate)
      .catch(() => {});
    return window.kiagent.on('push:update-state', (s) => {
      setUpdate(s);
      if (s.status !== 'checking') setChecking(false);
    });
  }, []);

  const check = () => {
    setChecking(true);
    void window.kiagent
      .invoke('update:check', undefined)
      .then(setUpdate)
      .catch(() => {})
      .finally(() => setChecking(false));
  };

  return { update, check, checking };
}

function UpdateControl(props: {
  update: UpdateState | null;
  checking: boolean;
  onCheck: () => void;
}): React.ReactElement | null {
  const status = props.update?.status;
  if (status === 'disabled') return null;
  if (status === 'downloaded')
    return (
      <Button
        size="sm"
        variant="primary"
        onClick={() =>
          void window.kiagent.invoke('update:quit-and-install', undefined)
        }
      >
        Restart to update
      </Button>
    );
  const busy =
    props.checking ||
    status === 'checking' ||
    status === 'available' ||
    status === 'downloading';
  return (
    <Button size="sm" disabled={busy} onClick={props.onCheck}>
      {props.checking || status === 'checking' ? 'Checking…' : 'Check now'}
    </Button>
  );
}

/**
 * General pane: startup, updates, and diagnostics (log level, log export,
 * and the way into the Logs page).
 */
export function General(): React.ReactElement {
  const prefs = useAppState((s) => s.prefs);
  const { navigate } = useView();
  const { update, check, checking } = useUpdates();
  const [info, setInfo] = useState<{
    version: string;
    productName: string;
  } | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportMsg, setExportMsg] = useState<string | null>(null);

  useEffect(() => {
    void window.kiagent
      .invoke('app:info', undefined)
      .then(setInfo)
      .catch(() => {});
  }, []);
  const productName = info?.productName ?? DEFAULT_PRODUCT_NAME;
  const version = info?.version ?? update?.currentVersion ?? null;

  const patch = (delta: Partial<AppPrefs>) => {
    void window.kiagent.invoke('prefs:patch', delta);
  };

  const exportLogs = () => {
    if (exporting) return;
    setExporting(true);
    setExportMsg(null);
    window.kiagent
      .invoke('logs:export', undefined)
      .then((path) =>
        window.kiagent.invoke('app:open-path', { path }).then(() => path),
      )
      .then((path) => setExportMsg(`Exported to ${path}`))
      .catch((e: unknown) =>
        setExportMsg(
          `Export failed: ${e instanceof Error ? e.message : 'unknown error'}`,
        ),
      )
      .finally(() => setExporting(false));
  };

  const percent =
    update?.status === 'downloading' && typeof update.percent === 'number'
      ? update.percent
      : null;

  return (
    <>
      <SettingsGroup title="Startup">
        <SettingsRow
          title="Open at login"
          description={`Start ${productName} when you sign in to this ${computerNoun()}`}
          control={
            <Toggle
              aria-label="Open at login"
              checked={prefs.launchAtLogin}
              onChange={(v) => patch({ launchAtLogin: v })}
            />
          }
        />
        <SettingsRow
          title="Show in menu bar"
          description="Quick status and record from the menu bar"
          control={
            <Toggle
              aria-label="Show in menu bar"
              checked={prefs.showInMenuBar}
              onChange={(v) => patch({ showInMenuBar: v })}
            />
          }
        />
      </SettingsGroup>

      <SettingsGroup title="Updates">
        <SettingsRow
          title={
            <>
              Version <span className="mono">{version ?? '—'}</span>
            </>
          }
          description={
            <>
              {updateLine(update, Date.now())}
              {percent != null && (
                <ProgressBar
                  aria-label="Update download"
                  value={percent / 100}
                />
              )}
            </>
          }
          control={
            <UpdateControl
              update={update}
              checking={checking}
              onCheck={check}
            />
          }
        />
      </SettingsGroup>

      <Disclosure label="Diagnostics">
        <div className="set-diag">
          <SettingsRow
            title="Log level"
            control={
              <Select
                aria-label="Log level"
                value={prefs.logLevel}
                onChange={(e) =>
                  patch({ logLevel: e.target.value as LogLevel })
                }
              >
                {LOG_LEVELS.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </Select>
            }
          />
          <div className="set-actions">
            <Button size="sm" disabled={exporting} onClick={exportLogs}>
              {exporting ? 'Exporting…' : 'Export logs…'}
            </Button>
            <TextButton onClick={() => navigate('logs')}>Open logs</TextButton>
          </div>
          {exportMsg && <div className="set-note">{exportMsg}</div>}
        </div>
      </Disclosure>
    </>
  );
}
