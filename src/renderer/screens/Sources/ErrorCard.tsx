import React, { useState } from 'react';
import type { Account } from '@shared/contracts';
import { Icon } from '@shared/web-ui/icon-sprite';
import { useView } from '@renderer/state/view';
import { connectorMeta, sourceLabel } from './connector-meta';
import { RemoveAccountModal } from './RemoveAccountModal';
import { SourceIcon } from './SourceIcon';
import { useSourceDescriptors } from './sources-registry';

/**
 * Prominent card for an erroring/needs-reauth account, shown above the
 * table (ui-inventory.md §2.2.2). The legacy card offered a connector-
 * specific OAuth `reauthChannel`; the new `Invokes` surface has no such
 * channel, so both statuses share one "Retry" action (`accounts:sync-now`,
 * which re-runs the account's pull loop) — a real command, not a fabricated
 * reconnect flow.
 */
export function ErrorCard(props: { account: Account }): React.ReactElement {
  const a = props.account;
  const descriptors = useSourceDescriptors();
  const meta = connectorMeta(a.source);
  const label = sourceLabel(a.source, descriptors);
  const needsReauth = a.status === 'needsReauth';
  const { navigate } = useView();
  const [retrying, setRetrying] = useState(false);
  const [showRemove, setShowRemove] = useState(false);

  async function retry(): Promise<void> {
    setRetrying(true);
    try {
      await window.kiagent.invoke('accounts:sync-now', { accountId: a.id });
    } finally {
      setRetrying(false);
    }
  }

  async function openDataFolder(): Promise<void> {
    const stats = await window.kiagent.invoke('storage:stats', undefined);
    await window.kiagent.invoke('app:open-path', { path: stats.dataDir });
  }

  return (
    <section className="card danger" aria-label={`${a.identifier} error`}>
      <div className="card-inner err-card-inner">
        <div className="err-card-head">
          <span
            className="conn-glyph"
            style={{ color: `var(--tag-${meta.tag}, var(--text-secondary))` }}
          >
            <SourceIcon sourceId={a.source} size={15} />
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 600 }}>{label}</div>
            <div
              className="mono"
              style={{ fontSize: 11, color: 'var(--text-secondary)' }}
            >
              {a.identifier}
            </div>
          </div>
          <span className="pill error">
            <span className="dot" />
            {needsReauth ? 'Reconnect' : 'Error'}
          </span>
          <button
            type="button"
            className="btn primary sm"
            disabled={retrying}
            onClick={() => void retry()}
          >
            <Icon name="refresh-cw" size={11} />
            {retrying ? 'Retrying…' : 'Retry'}
          </button>
        </div>

        <div className="err-detail">
          <Icon
            name="alert-circle"
            size={13}
            style={{ color: 'var(--error-solid)', marginTop: 1 }}
          />
          <div
            style={{
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              gap: 2,
            }}
          >
            <div className="title">
              {needsReauth ? 'Reconnect required' : 'Sync failed'}
            </div>
            <div className="detail-mono">{a.lastError ?? 'Unknown error'}</div>
          </div>
        </div>

        <div className="err-links">
          <button
            type="button"
            className="link"
            onClick={() => navigate('logs')}
          >
            <Icon name="log" size={12} />
            Show logs
          </button>
          <button
            type="button"
            className="link"
            onClick={() => void openDataFolder()}
          >
            <Icon name="folder" size={12} />
            Open data directory
          </button>
          <button
            type="button"
            className="link"
            style={{ color: 'var(--error-solid)' }}
            onClick={() => setShowRemove(true)}
          >
            <Icon name="trash" size={12} />
            Remove source
          </button>
        </div>
      </div>
      {showRemove && (
        <RemoveAccountModal
          identifier={a.identifier}
          onCancel={() => setShowRemove(false)}
          onConfirm={async () => {
            await window.kiagent.invoke('accounts:remove', { accountId: a.id });
            setShowRemove(false);
          }}
        />
      )}
    </section>
  );
}
