import React from 'react';
import type { Account } from '@shared/contracts';
import { useSourceDescriptors } from '../sources-registry';
import { describeCadence } from '../format';

/**
 * Read-only connector settings — per the task brief, a plain display of
 * `account.config` + identifier + the matched `SourceDescriptor`, rather
 * than the legacy manifest-driven config-panel/actions widgets (no
 * `configPanel`/`actions`/manifest concept exists on the new
 * `SourceDescriptor` — contracts.ts §3 — so there is nothing to render
 * controls for; this section always shows, unlike the legacy one which
 * self-hid).
 */
export function ConnectorConfig(props: {
  account: Account;
}): React.ReactElement {
  const a = props.account;
  const descriptors = useSourceDescriptors();
  const descriptor = descriptors?.find((d) => d.id === a.source);
  const configEntries = Object.entries(a.config ?? {});

  return (
    <section className="detail-card">
      <div className="lbl-section">Connector settings</div>
      <dl className="kv">
        <dt>Source id</dt>
        <dd className="mono">{a.source}</dd>
        <dt>Identifier</dt>
        <dd className="mono">{a.identifier}</dd>
        <dt>Auth</dt>
        <dd>{descriptor?.auth ?? '—'}</dd>
        <dt>Multi-account</dt>
        <dd>{descriptor ? (descriptor.multiAccount ? 'Yes' : 'No') : '—'}</dd>
        <dt>Document types</dt>
        <dd>
          {descriptor && descriptor.documentTypes.length > 0
            ? descriptor.documentTypes.join(', ')
            : '—'}
        </dd>
        <dt>Default cadence</dt>
        <dd>{descriptor ? describeCadence(descriptor.cadence) : '—'}</dd>
      </dl>
      <div className="lbl-section" style={{ marginTop: 8 }}>
        Account config
      </div>
      {configEntries.length === 0 ? (
        <div className="t-meta">
          No connector-specific configuration stored.
        </div>
      ) : (
        <pre className="cc-json">{JSON.stringify(a.config, null, 2)}</pre>
      )}
    </section>
  );
}
