import React, { useEffect, useState } from 'react';
import type { Account, Cadence as CadenceValue } from '@shared/contracts';
import type { ScheduledJob } from '@shared/ipc';
import { Icon } from '@shared/web-ui/icon-sprite';
import { describeCadence, formatRelative } from '../format';

interface Preset {
  key: string;
  label: string;
  cadence: CadenceValue | null;
}

const PRESETS: Preset[] = [
  { key: 'default', label: 'Source default', cadence: null },
  { key: 'manual', label: 'Manual only', cadence: 'manual' },
  { key: '5m', label: 'Every 5 minutes', cadence: { every: '5m' } },
  { key: '15m', label: 'Every 15 minutes', cadence: { every: '15m' } },
  { key: '30m', label: 'Every 30 minutes', cadence: { every: '30m' } },
  { key: '1h', label: 'Every hour', cadence: { every: '1h' } },
  { key: '6h', label: 'Every 6 hours', cadence: { every: '6h' } },
  { key: '24h', label: 'Every 24 hours', cadence: { every: '24h' } },
];

function keyFor(cadence: CadenceValue | undefined): string {
  if (cadence == null) return 'default';
  if (cadence === 'manual') return 'manual';
  if ('every' in cadence) {
    const preset = PRESETS.find(
      (p) =>
        p.cadence != null &&
        p.cadence !== 'manual' &&
        'every' in p.cadence &&
        p.cadence.every === cadence.every,
    );
    if (preset) return preset.key;
  }
  return 'custom';
}

const jobIdFor = (a: Account): string => `source:${a.source}:${a.id}`;

/**
 * Sync frequency. The legacy Cadence section was two focused/unfocused
 * polling-interval selects, self-hiding for non-`pollable` connectors — the
 * new `Cadence` contract (contracts.ts) is a single value (`{every}` /
 * `{cron}` / `'manual'`) set via `accounts:set-cadence`, and there is no
 * `pollable` flag on `SourceDescriptor` to gate visibility on, so this
 * always renders. Last/next run comes from `scheduler:jobs`, keyed by the
 * account's job id `source:<sourceId>:<accountId>`.
 */
export function Cadence(props: { account: Account }): React.ReactElement {
  const a = props.account;
  const jobId = jobIdFor(a);
  const [job, setJob] = useState<ScheduledJob | null>(null);
  const [pending, setPending] = useState(false);

  const refreshJob = async (): Promise<void> => {
    const jobs = await window.kiagent.invoke('scheduler:jobs', undefined);
    setJob(jobs.find((j) => j.id === jobId) ?? null);
  };

  useEffect(() => {
    void refreshJob();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refreshJob is stable per jobId
  }, [jobId]);

  async function apply(cadence: CadenceValue | null): Promise<void> {
    setPending(true);
    try {
      await window.kiagent.invoke('accounts:set-cadence', {
        accountId: a.id,
        cadence,
      });
      await refreshJob();
    } finally {
      setPending(false);
    }
  }

  async function runNow(): Promise<void> {
    setPending(true);
    try {
      await window.kiagent.invoke('scheduler:trigger', { id: jobId });
      await refreshJob();
    } finally {
      setPending(false);
    }
  }

  const currentKey = keyFor(a.cadence);
  const options =
    currentKey === 'custom' && a.cadence != null
      ? [
          ...PRESETS,
          {
            key: 'custom',
            label: describeCadence(a.cadence),
            cadence: a.cadence,
          },
        ]
      : PRESETS;

  return (
    <section className="detail-card">
      <div className="lbl-section">Sync frequency</div>
      <div className="cadence-row">
        <span className="lbl">Cadence</span>
        <select
          className="cadence-select"
          value={currentKey}
          disabled={pending}
          aria-label="Cadence"
          onChange={(e) => {
            const opt = options.find((o) => o.key === e.target.value);
            if (opt) void apply(opt.cadence);
          }}
        >
          {options.map((o) => (
            <option key={o.key} value={o.key}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
      <dl className="kv" style={{ marginTop: 4 }}>
        <dt>Last run</dt>
        <dd>{job ? formatRelative(job.lastRun) : '—'}</dd>
        <dt>Next run</dt>
        <dd>{job ? formatRelative(job.nextRun) : '—'}</dd>
      </dl>
      <button
        type="button"
        className="btn ghost sm"
        disabled={pending}
        onClick={() => void runNow()}
      >
        <Icon name="refresh-cw" size={11} />
        Run now
      </button>
    </section>
  );
}
