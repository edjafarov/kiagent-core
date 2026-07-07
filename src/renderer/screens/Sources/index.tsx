import React, { useState } from 'react';
import type { AccountId } from '@shared/contracts';
import { SourceDescriptorsProvider } from './sources-registry';
import { SourcesList } from './SourcesList';
import { SourceDetail } from './SourceDetail';
import './Sources.css';

type LocalView = { view: 'list' } | { view: 'detail'; accountId: AccountId };

/**
 * Top-level Sources screen. Detail navigation (list → detail(accountId) →
 * back) is LOCAL state here rather than a shell-level `View`, per the task
 * brief — the shared `View` union (state/view.ts) deliberately has no
 * `sources:detail` route.
 */
export function Sources(props: {
  onOpenConnection: () => void;
}): React.ReactElement {
  const [local, setLocal] = useState<LocalView>({ view: 'list' });

  return (
    <SourceDescriptorsProvider>
      <div className="dash-shell">
        {local.view === 'list' ? (
          <SourcesList
            onOpenDetail={(accountId) =>
              setLocal({ view: 'detail', accountId })
            }
            onOpenConnection={props.onOpenConnection}
          />
        ) : (
          <SourceDetail
            accountId={local.accountId}
            onBack={() => setLocal({ view: 'list' })}
          />
        )}
      </div>
    </SourceDescriptorsProvider>
  );
}
