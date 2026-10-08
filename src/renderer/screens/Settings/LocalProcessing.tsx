import React, { useCallback, useEffect, useState } from 'react';
import { useAppState } from '@renderer/state/app-state';
import { formatRelative } from '@renderer/screens/Sources/format';
import {
  AttentionList,
  AttentionRow,
  Busy,
  Button,
  Disclosure,
  ProgressBar,
  Row,
  Rows,
  Segmented,
  Select,
  SettingsGroup,
  SettingsRow,
  Status,
  Toggle,
  computerNoun,
} from '@shared/web-ui/ui';
import type { AppPrefs, LaneState, ProviderStatus } from '@shared/contracts';
import type { Invokes } from '@shared/ipc';

type ProcessingWindow = 'always' | 'night' | 'idle';
type ProviderRow = Invokes['inference:providers']['res'][number];
type ExtractionStatsRes = Invokes['inference:stats']['res'];
type ModelsRes = Invokes['inference:models']['res'];
type ModelsPrefs = AppPrefs['models'];

const WINDOWS: ReadonlyArray<{ key: ProcessingWindow; label: string }> = [
  { key: 'always', label: 'Always' },
  { key: 'idle', label: 'When idle' },
  { key: 'night', label: 'At night' },
];

/** One decimal place, e.g. 7121860000 -> "6.6". */
const gb = (totalBytes: number): string => (totalBytes / 1024 ** 3).toFixed(1);

/** Why background work isn't running right now — or null when it is (lane
 *  open). Said whether or not anything is waiting: the lane is the truth. */
export function pausedLine(lane: LaneState): string | null {
  if (lane === 'open') return null;
  switch (lane) {
    case 'disabled':
      return 'Off — background processing is turned off.';
    case 'battery':
      return 'Paused — on battery power.';
    case 'until-night':
      return 'Paused — runs overnight (22:00–07:00).';
    case 'until-synced':
      return 'Paused — waits until your accounts finish syncing.';
    case 'until-idle':
    default:
      return `Paused — waiting for this ${computerNoun()} to be idle.`;
  }
}

/** Human label for metadata.extraction.engine values. Every engine except
 *  these two is an OCR variant. */
function engineLabel(engine: string): string {
  if (engine === 'local-ocr+vlm') return 'OCR + description';
  if (engine === 'local-asr') return 'Transcript';
  return 'OCR';
}

/** "Active model: {label} — {GB} GB[ · installed| · downloads when needed]",
 *  or null when the catalog hasn't resolved yet or `selectedId` doesn't
 *  match any option (defensive; shouldn't happen). */
function activeModelLine(catalog: ModelsRes | null): string | null {
  if (!catalog) return null;
  const tier = catalog.options.find((o) => o.id === catalog.selectedId);
  if (!tier) return null;
  const suffix = tier.installed ? ' · installed' : ' · downloads when needed';
  return `Active model: ${tier.label} — ${gb(tier.totalBytes)} GB${suffix}`;
}

/** The Model disclosure's summary: the override, or what Auto resolved to. */
function modelSummary(override: string, catalog: ModelsRes | null): string {
  const tier = catalog?.options.find((o) => o.id === catalog.selectedId);
  const picked = tier ? ` (${tier.label}, ${gb(tier.totalBytes)} GB)` : '';
  if (override === 'auto')
    return `Auto — picked for this ${computerNoun()}${picked}`;
  const chosen = catalog?.options.find((o) => o.id === override);
  return chosen ? `${chosen.label}, ${gb(chosen.totalBytes)} GB` : override;
}

/** The pane's first line: ready or paused (and why), waiting, done.
 *  `waiting` and `lane` are the pushed app-state values, so this line and
 *  the sidebar indicator always show the same number (core
 *  `visualWaitingCount`). */
function statusLine(
  stats: ExtractionStatsRes,
  waiting: number,
  lane: LaneState,
): {
  tone: 'ok' | 'work' | 'off';
  text: string;
} {
  const paused = pausedLine(lane);
  const counts = `${waiting.toLocaleString()} ${
    waiting === 1 ? 'item' : 'items'
  } waiting · ${stats.processed.toLocaleString()} read or transcribed so far`;
  if (!paused) return { tone: 'ok', text: `Ready · ${counts}` };
  return {
    tone: lane === 'disabled' ? 'off' : 'work',
    text: `${paused.replace(/\.$/, '')} · ${counts}`,
  };
}

/** People's names for the providers; unknown ids show as they are. */
const PROVIDER_NAMES: Record<string, string> = {
  'local-llm': 'Language model',
  'local-asr': 'Speech model',
  'apple-vision': 'Vision (built in)',
  'windows-ocr': 'Text recognition (Windows)',
};
/**
 * Local AI pane: whether and when background local processing runs, which
 * model, what it did last — and the providers, only when one needs the
 * user (an error, a download in flight, or a model that will not download
 * by itself). The provider list has no push channel, so it is read on
 * mount and polled while a download runs; stats and the model catalog are
 * re-read after this pane's own pref writes land.
 */
export function LocalProcessing(): React.ReactElement {
  const processing = useAppState((s) => s.prefs.processing);
  const models = useAppState((s) => s.prefs.models);
  const live = useAppState((s) => s.processing);
  const [providers, setProviders] = useState<ProviderRow[] | null>(null);
  const [routedTo, setRoutedTo] = useState<string[]>([]);
  const [providersError, setProvidersError] = useState(false);
  const [stats, setStats] = useState<ExtractionStatsRes | null>(null);
  const [modelCatalog, setModelCatalog] = useState<ModelsRes | null>(null);

  const loadProviders = useCallback(() => {
    window.kiagent
      .invoke('inference:providers', undefined)
      .then((list) => {
        setProviders(list);
        setProvidersError(false);
      })
      .catch(() => setProvidersError(true));
  }, []);

  // Queue/processed stats and the model catalog — an expensive query,
  // deliberately NOT on the 2s download poll's clock (mount and after this
  // pane's own writes). selectedModel() memoizes the hardware probe, so the
  // catalog read is cheap. On failure keep the last-known values.
  const loadStats = useCallback(() => {
    window.kiagent
      .invoke('inference:stats', undefined)
      .then(setStats)
      .catch(() => {});
    window.kiagent
      .invoke('inference:models', undefined)
      .then(setModelCatalog)
      .catch(() => {});
  }, []);

  useEffect(() => {
    loadProviders();
    loadStats();
    window.kiagent
      .invoke('inference:routes', undefined)
      .then((rs) => setRoutedTo([...new Set(rs.map((r) => r.providerName))]))
      .catch(() => {});
  }, [loadProviders, loadStats]);

  // No push channel carries download progress, so poll while any provider
  // is mid-download; stop as soon as none are (and on unmount).
  useEffect(() => {
    const anyDownloading =
      providers?.some((p) => isDownloadingStatus(p.status)) ?? false;
    if (!anyDownloading) return undefined;
    const id = setInterval(loadProviders, 2000);
    return () => clearInterval(id);
  }, [providers, loadProviders]);

  // AppPrefs.processing / .models are nested objects (not themselves
  // Partial), so a patch resends the whole object with one field changed.
  // A model change can also change which provider needs a download, so
  // providers are re-read with the stats.
  const patch = (delta: Partial<AppPrefs>) => {
    void window.kiagent
      .invoke('prefs:patch', delta)
      .then(() => {
        loadStats();
        loadProviders();
      })
      .catch(() => {});
  };
  const install = (providerId: string) => {
    void window.kiagent
      .invoke('inference:install', { providerId })
      .then(loadProviders)
      .catch(() => setProvidersError(true));
  };
  // A model that will download when needed can be fetched now (e.g. before
  // going offline); one with automatic download off is an attention row.
  const optional = (providers ?? []).filter(
    (p) =>
      p.installable &&
      describeStatus(p.status).kind === 'standby' &&
      models.autoInstall,
  );

  const attention = (providers ?? []).filter((p) => needsAttention(p, models));
  const last = stats?.recent[0];

  return (
    <>
      {stats == null || live.waiting == null ? (
        <Busy label="Loading processing status…" />
      ) : (
        <div className="set-status">
          <Status tone={statusLine(stats, live.waiting, live.lane).tone}>
            {statusLine(stats, live.waiting, live.lane).text}
          </Status>
        </div>
      )}

      {(attention.length > 0 || providersError) && (
        <AttentionList aria-label="Providers that need you">
          {providersError && (
            <AttentionRow
              tone="err"
              kind="Error"
              title="Couldn’t load the local AI providers."
              action={
                <Button size="sm" onClick={loadProviders}>
                  Try again
                </Button>
              }
            />
          )}
          {attention.map((p) => (
            <ProviderAttention
              key={p.id}
              provider={p}
              refresh={loadProviders}
              onError={() => setProvidersError(true)}
            />
          ))}
        </AttentionList>
      )}

      <SettingsGroup>
        <SettingsRow
          title={`Read files on this ${computerNoun()}`}
          description={
            routedTo.length
              ? `Reads scans, photos and recordings on this ${computerNoun()}. Nothing else leaves it. Some tasks are sent to ${routedTo.join(' and ')}.`
              : `Reads scans, photos and recordings on this ${computerNoun()}. Nothing leaves it.`
          }
          control={
            <Toggle
              aria-label={`Read files on this ${computerNoun()}`}
              checked={processing.enabled}
              onChange={(v) =>
                patch({ processing: { ...processing, enabled: v } })
              }
            />
          }
        />
        <SettingsRow
          title="When to run"
          description="Heavy work waits so it doesn’t slow you down"
          control={
            <Segmented
              aria-label="When to run"
              items={WINDOWS}
              value={processing.window}
              disabled={!processing.enabled}
              onChange={(w) =>
                patch({ processing: { ...processing, window: w } })
              }
            />
          }
        />
      </SettingsGroup>

      <Disclosure
        label="Model"
        summary={modelSummary(models.override, modelCatalog)}
      >
        <SettingsRow
          title="Model"
          description={
            activeModelLine(modelCatalog) ??
            'Which local model tier handles scanned documents.'
          }
          control={
            <Select
              aria-label="Model override"
              value={models.override}
              onChange={(e) =>
                patch({ models: { ...models, override: e.target.value } })
              }
            >
              <option value="auto">
                Auto — picked for this {computerNoun()}
              </option>
              {modelCatalog?.options.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label} — {gb(o.totalBytes)} GB
                  {o.installed ? ' · installed' : ''}
                </option>
              ))}
            </Select>
          }
        />
        {optional.map((p) => (
          <SettingsRow
            key={p.id}
            title={PROVIDER_NAMES[p.id] ?? p.id}
            description="Downloads automatically when needed."
            control={
              <Button size="sm" onClick={() => install(p.id)}>
                Download now
              </Button>
            }
          />
        ))}
      </Disclosure>

      <Disclosure
        label="Recently processed"
        summary={
          last
            ? `last: ${last.title ?? last.filename ?? last.type} · ${formatRelative(last.updatedAt)}`
            : 'nothing yet'
        }
      >
        {stats == null || stats.recent.length === 0 ? (
          <div className="set-note">Nothing processed yet.</div>
        ) : (
          <Rows aria-label="Recently processed">
            {stats.recent.map((r) => (
              <Row
                key={r.id}
                title={r.title ?? r.filename ?? r.type}
                trail={
                  <span className="set-note">{engineLabel(r.engine)}</span>
                }
                time={formatRelative(r.updatedAt)}
              />
            ))}
          </Rows>
        )}
      </Disclosure>

      <div className="set-note">
        Providers (vision, language, speech) only appear here when one needs
        attention.
      </div>
    </>
  );
}

/** A provider the user has to act on or wait for. */
function needsAttention(p: ProviderRow, models: ModelsPrefs): boolean {
  const { kind } = describeStatus(p.status);
  if (kind === 'error' || kind === 'downloading') return true;
  return kind === 'standby' && p.installable && !models.autoInstall;
}

function ProviderAttention(props: {
  provider: ProviderRow;
  refresh: () => void;
  onError: () => void;
}): React.ReactElement {
  const { provider, refresh, onError } = props;
  const { kind, detail, percent } = describeStatus(provider.status);
  const name = PROVIDER_NAMES[provider.id] ?? provider.id;
  const run = (act: Promise<unknown>) => {
    void act.then(refresh).catch(onError);
  };
  const install = () =>
    run(
      window.kiagent.invoke('inference:install', { providerId: provider.id }),
    );
  const cancel = () =>
    run(window.kiagent.invoke('inference:cancel', undefined));

  if (kind === 'downloading')
    return (
      <AttentionRow
        tone="work"
        kind="Download"
        title={`${name} — downloading ${percent ?? 0}%`}
        detail={
          <ProgressBar
            aria-label={`${name} download`}
            value={(percent ?? 0) / 100}
          />
        }
        action={
          provider.installable ? (
            <Button size="sm" onClick={cancel}>
              Cancel
            </Button>
          ) : undefined
        }
      />
    );
  if (kind === 'error')
    return (
      <AttentionRow
        tone="err"
        kind="Error"
        title={name}
        sub={detail}
        action={
          provider.installable ? (
            <Button size="sm" onClick={install}>
              Retry
            </Button>
          ) : undefined
        }
      />
    );
  return (
    <AttentionRow
      tone="acc"
      kind="Model"
      title={name}
      sub="Automatic download is off."
      action={
        <Button size="sm" onClick={install}>
          Download now
        </Button>
      }
    />
  );
}

function isDownloadingStatus(
  status: ProviderStatus,
): status is { downloading: { pct: number } } {
  return (
    typeof status === 'object' && status !== null && 'downloading' in status
  );
}

function describeStatus(status: ProviderStatus): {
  kind: 'ready' | 'standby' | 'unsupported' | 'downloading' | 'error';
  detail: string | null;
  percent: number | null;
} {
  if (status === 'ready') return { kind: 'ready', detail: null, percent: null };
  if (status === 'standby')
    return { kind: 'standby', detail: null, percent: null };
  if (status === 'unsupported')
    return { kind: 'unsupported', detail: null, percent: null };
  if (isDownloadingStatus(status))
    return {
      kind: 'downloading',
      detail: null,
      percent: Math.round(status.downloading.pct),
    };
  if (typeof status === 'object' && status !== null && 'error' in status)
    return { kind: 'error', detail: status.error, percent: null };
  return { kind: 'unsupported', detail: null, percent: null };
}
