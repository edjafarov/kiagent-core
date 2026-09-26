import React, { useState } from 'react';
import { ConnectionAdvanced } from './ConnectionAdvanced';
import { ConnectionMain } from './ConnectionMain';

/**
 * Connection — how an AI app reaches this memory: the apps on this
 * computer, every request they make, and (Advanced) the local server with
 * its manual setup. A product composes the same two pages with its own
 * remote card (see ConnectionMain's `remote`).
 */
export function Connection(): React.ReactElement {
  const [view, setView] = useState<'main' | 'advanced'>('main');
  return view === 'advanced' ? (
    <ConnectionAdvanced onBack={() => setView('main')} />
  ) : (
    <ConnectionMain onAdvanced={() => setView('advanced')} />
  );
}
