import React, { useEffect, useState } from 'react';
import { useAppState } from '@renderer/state/app-state';
import {
  Busy,
  Button,
  Card,
  ConfirmSheet,
  Disclosure,
  KeyValue,
  SettingsGroup,
  SettingsRow,
  TextButton,
  computerNoun,
} from '@shared/web-ui/ui';
import type { StorageStats } from '@shared/ipc';
import { describeResetOutcome } from '@shared/reset-outcome';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

function failure(e: unknown): string {
  return `Failed: ${e instanceof Error ? e.message : 'unknown error'}`;
}

type Op = 'compact' | 'export';

/**
 * Storage pane: what is stored and where, export, compact, and reset.
 *
 * `afterWipe` is a product build's last reset step (e.g. clearing a
 * device-ownership record). It runs ONLY after the core wipe reports
 * `coreWiped === true` — a partial or unknown wipe leaves whatever it
 * guards in place, so a crash mid-reset fails closed. A returned sentence
 * is added to the reset's own.
 *
 * The reset outcome is a native dialog: reset clears identity before it
 * answers, so the identity gate unmounts this pane and only a dialog is
 * still there to read.
 */
export function Storage(props: {
  afterWipe?: () => Promise<string | null>;
}): React.ReactElement {
  const { afterWipe } = props;
  const [stats, setStats] = useState<StorageStats | null>(null);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState<Op | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<'compact' | 'reset' | null>(null);
  // Cheap "something changed" signal to re-fetch stats — re-used from the
  // live projection instead of a bespoke push subscription.
  const seqSignal = useAppState((s) => s.accounts.length + s.processing.done);
  const extensions = useAppState((s) => s.extensions);
  const extensionName = (id: string) =>
    extensions.find((e) => e.id === id)?.name ?? id;

  useEffect(() => {
    let alive = true;
    window.kiagent
      .invoke('storage:stats', undefined)
      .then((s) => {
        if (alive) {
          setStats(s);
          setError(false);
        }
      })
      .catch(() => {
        if (alive) setError(true);
      });
    return () => {
      alive = false;
    };
  }, [seqSignal]);

  const exportData = () => {
    if (busy) return;
    setBusy('export');
    setNote(null);
    // Empty destDir asks main to show a directory picker.
    void window.kiagent
      .invoke('maintenance:export', { destDir: '' })
      .then(() => setNote('Export complete.'))
      .catch((e: unknown) => setNote(failure(e)))
      .finally(() => setBusy(null));
  };

  const compact = async () => {
    setBusy('compact');
    setNote(null);
    try {
      await window.kiagent.invoke('maintenance:compact', undefined);
      setNote('Database compacted.');
    } catch (e) {
      setNote(failure(e));
    } finally {
      setBusy(null);
    }
  };

  const resetAll = async () => {
    try {
      const outcome = await window.kiagent.invoke(
        'maintenance:reset-all',
        undefined,
      );
      const told = describeResetOutcome(outcome, extensionName);
      const extra =
        outcome.coreWiped === true && afterWipe
          ? await afterWipe().catch((e: unknown) => failure(e))
          : null;
      window.alert(extra ? `${told} ${extra}` : told);
    } catch (e) {
      window.alert(failure(e));
    } finally {
      // A reset that wiped the core has unmounted this pane by now; one
      // that stopped short leaves the pane, so the sheet closes.
      setConfirm(null);
    }
  };

  if (stats == null)
    return error ? (
      <div className="set-note">Couldn’t load storage stats.</div>
    ) : (
      <Busy label="Loading storage stats…" />
    );

  return (
    <>
      <Card>
        <KeyValue
          items={[
            { label: 'Items', value: stats.docCount.toLocaleString() },
            { label: 'Sources', value: stats.accountCount.toLocaleString() },
            { label: 'Size on disk', value: formatBytes(stats.dbBytes) },
            {
              label: 'Location',
              value: (
                <span className="set-actions">
                  <span className="mono" data-testid="data-folder-path">
                    {stats.dataDir}
                  </span>
                  <TextButton
                    onClick={() =>
                      void window.kiagent.invoke('app:open-path', {
                        path: stats.dataDir,
                      })
                    }
                  >
                    Show in Finder
                  </TextButton>
                </span>
              ),
            },
          ]}
        />
      </Card>

      <SettingsGroup>
        <SettingsRow
          title="Export your data"
          description="A copy of everything, as files"
          control={
            <Button size="sm" disabled={!!busy} onClick={exportData}>
              {busy === 'export' ? 'Exporting…' : 'Export…'}
            </Button>
          }
        />
      </SettingsGroup>

      <Disclosure label="Maintenance" summary="Compact the database">
        <SettingsRow
          title="Compact the database"
          description="Reclaims unused pages from removed items. Safe to run at any time; may take a minute."
          control={
            <Button
              size="sm"
              disabled={!!busy}
              onClick={() => setConfirm('compact')}
            >
              {busy === 'compact' ? 'Compacting…' : 'Compact'}
            </Button>
          }
        />
      </Disclosure>

      {note && <div className="set-note">{note}</div>}

      <SettingsGroup title="Reset">
        <SettingsRow
          title="Reset all data"
          description={`Deletes your whole memory from this ${computerNoun()}. Can’t be undone.`}
          control={
            <Button
              size="sm"
              variant="danger"
              disabled={!!busy}
              onClick={() => setConfirm('reset')}
            >
              Reset…
            </Button>
          }
        />
      </SettingsGroup>

      {confirm === 'compact' && (
        <ConfirmSheet
          title="Compact the database?"
          confirmLabel="Compact"
          busyLabel="Compacting…"
          onConfirm={async () => {
            setConfirm(null);
            await compact();
          }}
          onClose={() => setConfirm(null)}
        >
          Safe to run at any time, but may take a minute on a large memory.
        </ConfirmSheet>
      )}
      {confirm === 'reset' && (
        <ConfirmSheet
          title="Reset all data?"
          confirmLabel="Reset all data"
          busyLabel="Resetting…"
          tone="danger"
          onConfirm={resetAll}
          onClose={() => setConfirm(null)}
        >
          This deletes everything this app has stored on this {computerNoun()} —
          every source, item and setting. It can’t be undone.
        </ConfirmSheet>
      )}
    </>
  );
}
