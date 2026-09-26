import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import type { SourceDescriptor } from '@shared/contracts';
import { useAppState } from '@renderer/state/app-state';

/**
 * `sources:list` shared down the Sources screen tree — every place that
 * needs a connector's display name / auth kind / cadence default reads from
 * here instead of re-invoking. It re-reads when an extension is installed,
 * removed, turned on or off, or re-activated, so a just-installed
 * connector's source appears without a remount.
 */
const SourceDescriptorsContext = createContext<SourceDescriptor[] | null>(null);

/** What a product decides about the Sources pages. */
export interface SourcesPolicy {
  /** Source ids the product manages elsewhere: never listed or offered. */
  hidden: readonly string[];
  /** Whether the list page shows the get-started checklist. */
  showGetStarted: boolean;
}

const DEFAULT_POLICY: SourcesPolicy = { hidden: [], showGetStarted: true };
const SourcesPolicyContext = createContext<SourcesPolicy>(DEFAULT_POLICY);

export function SourceDescriptorsProvider(props: {
  hidden?: readonly string[];
  showGetStarted?: boolean;
  children: React.ReactNode;
}): React.ReactElement {
  const [descriptors, setDescriptors] = useState<SourceDescriptor[] | null>(
    null,
  );
  const extensionsKey = useAppState((s) =>
    s.extensions
      .map((e) => `${e.id}:${e.status}:${e.activatedAt ?? ''}`)
      .join('|'),
  );

  useEffect(() => {
    let cancelled = false;
    window.kiagent
      .invoke('sources:list', undefined)
      .then((list) => {
        if (!cancelled) setDescriptors(list);
      })
      .catch(() => {
        // Keep what a re-read had; a first read that fails is an empty list.
        if (!cancelled) setDescriptors((prev) => prev ?? []);
      });
    return () => {
      cancelled = true;
    };
  }, [extensionsKey]);

  const hiddenKey = (props.hidden ?? []).join('\n');
  const policy = useMemo<SourcesPolicy>(
    () => ({
      hidden: hiddenKey ? hiddenKey.split('\n') : [],
      showGetStarted: props.showGetStarted ?? true,
    }),
    [hiddenKey, props.showGetStarted],
  );
  const visible = useMemo(
    () => descriptors?.filter((d) => !policy.hidden.includes(d.id)) ?? null,
    [descriptors, policy],
  );

  return (
    <SourcesPolicyContext.Provider value={policy}>
      <SourceDescriptorsContext.Provider value={visible}>
        {props.children}
      </SourceDescriptorsContext.Provider>
    </SourcesPolicyContext.Provider>
  );
}

/** `null` while loading, else the (possibly empty) descriptor list, minus
 *  the policy's hidden ids. */
export function useSourceDescriptors(): SourceDescriptor[] | null {
  return useContext(SourceDescriptorsContext);
}

export function useSourcesPolicy(): SourcesPolicy {
  return useContext(SourcesPolicyContext);
}
