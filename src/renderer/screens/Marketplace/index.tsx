import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useAppState } from '@renderer/state/app-state';
import { Icon } from '@shared/web-ui/icon-sprite';
import { ExtGlyph } from '@renderer/components/ExtGlyph';
import type { MarketplaceListItem, UpdateInfo } from '@shared/ipc';
import { buildRows } from './rows';
import type { MarketplaceFilter } from './rows';
import { Detail } from './Detail';
import './Marketplace.css';

const FILTERS: Array<{ key: MarketplaceFilter; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'official', label: 'Official store' },
  { key: 'installed', label: 'Installed' },
];

/**
 * Marketplace screen — functional list pane over the kia-plugins catalog,
 * plus the Detail pane (readme, install/uninstall, permission review) for
 * whichever row is selected. Installed-ness and the enabled flag come from
 * the live AppState projection (`extensions`), never from the list
 * response's `installedId` hint, so a fresh install/uninstall reflects
 * here without re-fetching the catalog.
 */
export function Marketplace(): React.ReactElement {
  const [items, setItems] = useState<MarketplaceListItem[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [updates, setUpdates] = useState<UpdateInfo[]>([]);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<MarketplaceFilter>('all');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const extensions = useAppState((s) => s.extensions);

  // Guards state updates from a fetch that resolves after unmount. A ref
  // (not the effect-local `let alive` some sibling screens use) because
  // Retry re-invokes the same fetch from outside the mount effect.
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const fetchList = useCallback(() => {
    setListError(null);
    window.kiagent
      .invoke('marketplace:list', undefined)
      .then((list) => {
        if (aliveRef.current) setItems(list);
      })
      .catch((e: unknown) => {
        if (aliveRef.current) {
          setListError(e instanceof Error ? e.message : String(e));
        }
      });
  }, []);

  useEffect(() => {
    fetchList();
    // Badge data is best-effort, fetched once per mount — Retry only
    // re-runs the list fetch above, not this.
    window.kiagent
      .invoke('marketplace:check-updates', undefined)
      .then((list) => {
        if (aliveRef.current) setUpdates(list);
      })
      .catch(() => {});
  }, [fetchList]);

  const rows =
    items != null ? buildRows(items, extensions, updates, filter, query) : [];
  const selectedRow = rows.find((r) => r.key === selectedKey) ?? null;

  return (
    <div className="dash-shell mkt-shell">
      <div className="mkt-pane mkt-left">
        <div className="mkt-header">
          <span className="h-section">Marketplace</span>
          <span className="t-meta">
            Browse and install connector extensions.
          </span>
        </div>

        <div className="mkt-search">
          <input
            className="input"
            type="text"
            placeholder="Search plugins…"
            aria-label="Search plugins"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>

        <div className="mkt-filters">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              className={
                f.key === filter ? 'btn ghost sm active' : 'btn ghost sm'
              }
              onClick={() => setFilter(f.key)}
            >
              {f.label}
            </button>
          ))}
        </div>

        {items === null && !listError ? (
          <div className="mkt-list mkt-list-empty">
            <p className="t-meta">Loading catalog…</p>
          </div>
        ) : listError ? (
          <div className="mkt-list mkt-list-empty">
            <p className="t-meta">{listError}</p>
            <button type="button" className="btn ghost sm" onClick={fetchList}>
              Retry
            </button>
          </div>
        ) : rows.length === 0 ? (
          <div className="mkt-list mkt-list-empty">
            <p className="t-meta">No plugins found.</p>
          </div>
        ) : (
          <div className="mkt-list">
            {rows.map((row) => (
              <button
                key={row.key}
                type="button"
                className={
                  row.key === selectedKey ? 'mkt-row selected' : 'mkt-row'
                }
                onClick={() => setSelectedKey(row.key)}
              >
                <div className="mkt-row-title">
                  <ExtGlyph
                    name={row.title}
                    iconDataUrl={row.iconDataUrl}
                    size={22}
                    boxed
                  />
                  <span>{row.title}</span>
                  {row.installed && (
                    <span className="mkt-badge">Installed</span>
                  )}
                  {row.updateAvailable && (
                    <span className="mkt-badge update">Update</span>
                  )}
                  {row.installed && !row.installed.enabled && (
                    <span className="mkt-badge">Disabled</span>
                  )}
                </div>
                <span className="t-meta">{row.subtitle}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="mkt-pane mkt-right">
        {selectedRow ? (
          <Detail key={selectedRow.key} row={selectedRow} />
        ) : (
          <div className="mkt-right-empty">
            <div className="mkt-notice card">
              <div className="mkt-notice-icon">
                <Icon name="database" size={20} />
              </div>
              <p className="t-meta">Select an extension to see details.</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
