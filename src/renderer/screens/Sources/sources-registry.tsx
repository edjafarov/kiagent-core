import React, { createContext, useContext, useEffect, useState } from 'react';
import type { SourceDescriptor } from '@shared/contracts';

/**
 * `sources:list` fetched once and shared down the Sources screen tree —
 * every place that needs a connector's display name / auth kind / cadence
 * default (the table, error cards, the add-source tile grid, ConnectorConfig)
 * reads from here instead of re-invoking.
 */
const SourceDescriptorsContext = createContext<SourceDescriptor[] | null>(null);

export function SourceDescriptorsProvider(props: {
  children: React.ReactNode;
}): React.ReactElement {
  const [descriptors, setDescriptors] = useState<SourceDescriptor[] | null>(
    null,
  );

  useEffect(() => {
    let cancelled = false;
    window.kiagent
      .invoke('sources:list', undefined)
      .then((list) => {
        if (!cancelled) setDescriptors(list);
      })
      .catch(() => {
        if (!cancelled) setDescriptors([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <SourceDescriptorsContext.Provider value={descriptors}>
      {props.children}
    </SourceDescriptorsContext.Provider>
  );
}

/** `null` while loading, else the (possibly empty) descriptor list. */
export function useSourceDescriptors(): SourceDescriptor[] | null {
  return useContext(SourceDescriptorsContext);
}
