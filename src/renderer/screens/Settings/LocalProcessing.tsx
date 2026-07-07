import React, { useCallback, useEffect, useState } from 'react';
import { useAppState } from '@renderer/state/app-state';
import { formatRelative } from '@renderer/screens/Sources/format';
import { Pill } from '@shared/web-ui/components';
import type { PillVariant } from '@shared/web-ui/components';
import { Icon } from '@shared/web-ui/icon-sprite';
import type { AppPrefs, ProviderStatus } from '@shared/contracts';
import type { Invokes } from '@shared/ipc';

type ProcessingWindow = 'always' | 'night' | 'idle';
type ProviderRow = Invokes['inference:providers']['res'][number];
type ExtractionStatsRes = Invokes['inference:stats']['res'];
type ModelsRes = Invokes['inference:models']['res'];
type ModelsPrefs = AppPrefs['models'];

const WINDOW_OPTIONS: ReadonlyArray<[ProcessingWindow, string, string]> = [
  ['always', 'Always', 'Process continuously while the app is open.'],
  ['idle', 'When idle', 'Wait until this Mac is idle.'],
  ['night', 'At night', 'Only run overnight (22:00–07:00).'],
];

/** One decimal place, e.g. 7121860000 -> "6.6". */
const gb = (totalBytes: number): string => (totalBytes / 1024 ** 3).toFixed(1);

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

/**
 * Local processing pane. `AppPrefs.processing` is a small
 * `{enabled, window}` pair (no per-model download/schedule config like the
 * legacy deep-runtime screen) — the "Settings" section below is that pair.
 * The provider list is a separate, unrelated read
 * (`inference:providers`) with no push channel in this contract's `Pushes`
 * union, so it's fetched once on mount plus a manual Refresh button rather
 * than faking a live subscription.
 */
export function LocalProcessing(): React.ReactElement {
  const processing = useAppState((s) => s.prefs.processing);
  const models = useAppState((s) => s.prefs.models);
  const [providers, setProviders] = useState<ProviderRow[] | null>(null);
  const [providersError, setProvidersError] = useState(false);
  const [loadingProviders, setLoadingProviders] = useState(false);
  const [stats, setStats] = useState<ExtractionStatsRes | null>(null);
  const [modelCatalog, setModelCatalog] = useState<ModelsRes | null>(null);

  const loadProviders = useCallback(() => {
    setLoadingProviders(true);
    window.kiagent
      .invoke('inference:providers', undefined)
      .then((list) => {
        setProviders(list);
        setProvidersError(false);
      })
      .catch(() => setProvidersError(true))
      .finally(() => setLoadingProviders(false));
    // Piggybacked queue/processed stats — same clock as the provider reads
    // (mount, Refresh, download poll). On failure keep the last-known values.
    window.kiagent
      .invoke('inference:stats', undefined)
      .then(setStats)
      .catch(() => {});
    // Piggybacked model catalog + resolved selection — same clock as above.
    // Safe to ride the download poll: selectedModel() memoizes the hardware
    // probe on the provider (`backend`, detected once, lazily), so repeated
    // calls don't re-detect. On failure keep the last-known values.
    window.kiagent
      .invoke('inference:models', undefined)
      .then(setModelCatalog)
      .catch(() => {});
  }, []);

  useEffect(() => {
    loadProviders();
  }, [loadProviders]);

  // No push channel carries download progress, so poll while any provider
  // is mid-download; stop as soon as none are (and on unmount).
  useEffect(() => {
    const anyDownloading = providers?.some((p) => isDownloadingStatus(p.status)) ?? false;
    if (!anyDownloading) return undefined;
    const id = setInterval(loadProviders, 2000);
    return () => clearInterval(id);
  }, [providers, loadProviders]);

  // AppPrefs.processing is a single nested object (not itself Partial), so a
  // patch must resend it whole — merge the current value with the one field
  // that changed rather than dropping its sibling.
  const toggleEnabled = () => {
    void window.kiagent.invoke('prefs:patch', {
      processing: { ...processing, enabled: !processing.enabled },
    });
  };
  const setWindow = (w: ProcessingWindow) => {
    void window.kiagent.invoke('prefs:patch', { processing: { ...processing, window: w } });
  };
  const setModelOverride = (override: string) => {
    void window.kiagent.invoke('prefs:patch', { models: { ...models, override } });
  };

  return (
    <>
      <div>
        <h2 className="h-screen">Local processing</h2>
        <div className="t-meta">Local inference providers, and when background work runs.</div>
      </div>
      <div className="div-h" />

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div className="lbl-section">Settings</div>
        <div className="pref-list">
          <div className="pref-row">
            <div className="pref-meta">
              <span className="pref-label">Enabled</span>
              <span className="pref-desc">
                Allow background local processing to run at all.
              </span>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={processing.enabled}
              aria-label="Enabled"
              className={processing.enabled ? 'toggle on' : 'toggle'}
              onClick={toggleEnabled}
            >
              <span className="knob" />
            </button>
          </div>

          <div className="pref-row" style={{ alignItems: 'flex-start' }}>
            <div className="pref-meta">
              <span className="pref-label">Window</span>
              <span className="pref-desc">
                {WINDOW_OPTIONS.find(([v]) => v === processing.window)?.[2] ?? ''}
              </span>
            </div>
            <div
              role="radiogroup"
              aria-label="Processing window"
              style={{ display: 'flex', flexDirection: 'column', gap: 4 }}
            >
              {WINDOW_OPTIONS.map(([value, label]) => (
                <label key={value} className="radio-row">
                  <input
                    type="radio"
                    name="processing-window"
                    value={value}
                    checked={processing.window === value}
                    disabled={!processing.enabled}
                    onChange={() => setWindow(value)}
                  />
                  {label}
                </label>
              ))}
            </div>
          </div>

          <div className="pref-row">
            <div className="pref-meta">
              <span className="pref-label">Model</span>
              <span className="pref-desc">Which local model tier handles scanned documents.</span>
            </div>
            <select
              className="cadence-select"
              aria-label="Model override"
              value={models.override}
              onChange={(e) => setModelOverride(e.target.value)}
            >
              <option value="auto">Auto — picked for this Mac</option>
              {modelCatalog?.options.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label} — {gb(o.totalBytes)} GB{o.installed ? ' · installed' : ''}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      <div className="div-h" />

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div className="lbl-section">Providers</div>
          <span style={{ flex: 1 }} />
          <button type="button" className="btn ghost sm" disabled={loadingProviders} onClick={loadProviders}>
            <Icon name="refresh-cw" size={12} /> {loadingProviders ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>

        {providersError && (
          <div className="t-meta" style={{ color: 'var(--error-solid)' }}>
            Couldn&rsquo;t load inference providers.
          </div>
        )}
        {providers == null ? (
          providersError ? null : <div className="t-meta">Loading providers…</div>
        ) : providers.length === 0 ? (
          <div className="lp-empty">
            <div className="t-meta">No local model is installed yet.</div>
            <div className="t-meta">
              Local inference runs entirely on this machine once a provider is available. The local
              model downloads automatically when scanned documents need it, or on demand above.
            </div>
          </div>
        ) : (
          <div className="pref-list">
            {providers.map((p) => (
              <ProviderRowView
                key={p.id}
                provider={p}
                models={models}
                modelCatalog={modelCatalog}
                refresh={loadProviders}
                setProvidersError={setProvidersError}
              />
            ))}
          </div>
        )}

        {stats != null && (
          <div className="t-meta">
            {stats.pendingOcr} pending OCR · {stats.awaitingVlm} awaiting
            description · {stats.processed} processed
          </div>
        )}
      </div>

      {stats != null && (
        <>
          <div className="div-h" />

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div className="lbl-section">Recently processed</div>
            {stats.recent.length === 0 ? (
              <div className="t-meta">Nothing processed yet.</div>
            ) : (
              <div className="pref-list">
                {stats.recent.map((r) => (
                  <div key={r.id} className="pref-row">
                    <div className="pref-meta">
                      <span
                        className="pref-label"
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 8,
                        }}
                      >
                        {r.title ?? r.filename ?? r.type}
                        <Pill variant="info">
                          {r.engine === 'local-ocr+vlm'
                            ? 'OCR + description'
                            : 'OCR'}
                        </Pill>
                      </span>
                    </div>
                    <span className="t-meta">
                      {formatRelative(r.updatedAt)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </>
  );
}

function ProviderRowView(props: {
  provider: ProviderRow;
  models: ModelsPrefs;
  modelCatalog: ModelsRes | null;
  refresh: () => void;
  setProvidersError: (error: boolean) => void;
}): React.ReactElement {
  const { provider, models, modelCatalog, refresh, setProvidersError } = props;
  const { kind, pill, detail, percent } = describeStatus(provider.status);
  const isLocalLlm = provider.id === 'local-llm';
  const activeModel = isLocalLlm ? activeModelLine(modelCatalog) : null;

  const install = () => {
    void window.kiagent
      .invoke('inference:install', undefined)
      .then(refresh)
      .catch(() => setProvidersError(true));
  };
  const cancel = () => {
    void window.kiagent
      .invoke('inference:cancel', undefined)
      .then(refresh)
      .catch(() => setProvidersError(true));
  };

  return (
    <div className="pref-row" style={{ alignItems: 'flex-start' }}>
      <div className="pref-meta">
        <span className="pref-label" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {provider.id}
          {pill && <Pill variant={pill.variant}>{pill.label}</Pill>}
        </span>
        <span className="pref-desc">
          Supports: {provider.supports.length > 0 ? provider.supports.join(', ') : '—'}
        </span>
        {activeModel && <span className="pref-desc">{activeModel}</span>}
        {detail && (
          <span className="pref-desc" style={{ color: 'var(--error-solid)' }}>
            {detail}
          </span>
        )}
        {isLocalLlm && kind === 'standby' && (
          <span className="pref-desc">
            {models.autoInstall
              ? 'Downloads automatically when scanned documents need it.'
              : 'Automatic download is off.'}
          </span>
        )}
        {percent != null && (
          <div className="progress" style={{ marginTop: 4 }}>
            <i style={{ width: `${percent}%` }} />
          </div>
        )}
      </div>
      {isLocalLlm && kind === 'standby' && (
        <button type="button" className="btn ghost sm" onClick={install}>
          Download now
        </button>
      )}
      {isLocalLlm && kind === 'downloading' && (
        <button type="button" className="btn ghost sm" onClick={cancel}>
          Cancel
        </button>
      )}
      {isLocalLlm && kind === 'error' && (
        <button type="button" className="btn ghost sm" onClick={install}>
          Retry
        </button>
      )}
    </div>
  );
}

function isDownloadingStatus(status: ProviderStatus): status is { downloading: { pct: number } } {
  return typeof status === 'object' && status !== null && 'downloading' in status;
}

function describeStatus(status: ProviderStatus): {
  kind: 'ready' | 'standby' | 'unsupported' | 'downloading' | 'error';
  pill: { variant: PillVariant; label: string } | null;
  detail: string | null;
  percent: number | null;
} {
  if (status === 'ready') {
    return { kind: 'ready', pill: { variant: 'live', label: 'Ready' }, detail: null, percent: null };
  }
  if (status === 'standby') {
    return { kind: 'standby', pill: { variant: 'paused', label: 'Standby' }, detail: null, percent: null };
  }
  if (status === 'unsupported') {
    return {
      kind: 'unsupported',
      pill: null,
      detail: 'Unsupported on this hardware.',
      percent: null,
    };
  }
  if (isDownloadingStatus(status)) {
    return {
      kind: 'downloading',
      pill: { variant: 'working', label: 'Downloading' },
      detail: null,
      percent: Math.round(status.downloading.pct),
    };
  }
  if (typeof status === 'object' && status !== null && 'error' in status) {
    return { kind: 'error', pill: { variant: 'error', label: 'Error' }, detail: status.error, percent: null };
  }
  return { kind: 'unsupported', pill: null, detail: null, percent: null };
}
