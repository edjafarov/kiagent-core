import React, { useEffect, useState } from 'react';
import { Spark } from '@shared/web-ui/Spark';
import { Icon } from '@shared/web-ui/icon-sprite';
import { Button, Card, KeyValue } from '@shared/web-ui/ui';
import { DEFAULT_PRODUCT_NAME } from '@shared/product';

const REPO_URL = 'https://github.com/edjafarov/kiagent-core';
const LICENSE = 'MIT';

/** `process.platform` as people say it. */
function platformName(p: string): string {
  if (p === 'darwin') return 'macOS';
  if (p === 'win32') return 'Windows';
  if (p === 'linux') return 'Linux';
  return p;
}

/**
 * About pane: what the app is, its version, platform and license, and the
 * repository. Updates live on General.
 */
export function About(): React.ReactElement {
  const [info, setInfo] = useState<{
    version: string;
    platform: string;
    productName: string;
  } | null>(null);

  useEffect(() => {
    void window.kiagent
      .invoke('app:info', undefined)
      .then(setInfo)
      .catch(() => {});
  }, []);

  // Brand name comes from the resolved product config (app:info), never from a
  // literal here — a product build supplies product.json and needs no source
  // edit. DEFAULT_PRODUCT_NAME covers the pre-response frame and is the same
  // constant main defaults to, so the two can't disagree.
  const productName = info?.productName ?? DEFAULT_PRODUCT_NAME;

  return (
    <>
      <Card>
        <div className="set-brand">
          <span className="set-brand-mark">
            <Spark size="app" />
          </span>
          <div>
            <div className="set-brand-name">{productName}</div>
            <div className="set-brand-tag">
              A local-first connector and indexer for your communications.
              Everything stays on this machine.
            </div>
          </div>
        </div>
      </Card>
      <Card>
        <KeyValue
          items={[
            {
              label: 'Version',
              value: <span className="mono">{info?.version ?? '—'}</span>,
            },
            {
              label: 'Platform',
              value: (
                <span className="mono">
                  {info ? platformName(info.platform) : '—'}
                </span>
              ),
            },
            { label: 'License', value: LICENSE },
          ]}
        />
      </Card>
      <div className="set-actions">
        <Button size="sm" onClick={() => window.open(REPO_URL, '_blank')}>
          <Icon name="external" size={12} /> GitHub
        </Button>
        <Button
          size="sm"
          onClick={() => window.open(`${REPO_URL}/releases`, '_blank')}
        >
          <Icon name="external" size={12} /> Release notes
        </Button>
      </div>
      <div className="set-note">
        © 2026 {productName} contributors. Made with care for offline-first
        knowledge work.
      </div>
    </>
  );
}
