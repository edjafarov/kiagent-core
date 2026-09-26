import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import type { AppState, SourceDescriptor } from '@shared/contracts';
import { useAppState } from '@renderer/state/app-state';

/**
 * `sources:list` and the product's Sources policy, provided once at the
 * app root and shared by every surface (Sources, Home, Settings) — every place that
 * needs a connector's display name / auth kind / cadence default reads from
 * here instead of re-invoking. It re-reads when an extension is installed,
 * removed, turned on or off, or re-activated, so a just-installed
 * connector's source appears without a remount.
 */
// `undefined` = no provider above: a wiring mistake, reported loudly
// rather than read as "still loading" forever.
const SourceDescriptorsContext = createContext<
  SourceDescriptor[] | null | undefined
>(undefined);

/** What a product decides about the Sources pages. */
export interface SourcesPolicy {
  /** Source ids the product manages elsewhere: never listed or offered. */
  hidden: readonly string[];
  /** Whether the list page shows the get-started checklist. */
  showGetStarted: boolean;
}

const SourcesPolicyContext = createContext<SourcesPolicy | undefined>(
  undefined,
);

function required<T>(value: T | undefined, hook: string): T {
  if (value === undefined)
    throw new Error(`${hook} needs a SourceDescriptorsProvider above it`);
  return value;
}

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
  return required(useContext(SourceDescriptorsContext), 'useSourceDescriptors');
}

export function useSourcesPolicy(): SourcesPolicy {
  return required(useContext(SourcesPolicyContext), 'useSourcesPolicy');
}

/** The account entries the product shows here: rows, counts, selection,
 *  Sync all and get-started all read this one list. */
export function useVisibleAccounts(): AppState['accounts'] {
  const { hidden } = useSourcesPolicy();
  const entries = useAppState((s) => s.accounts);
  return useMemo(
    () => entries.filter((e) => !hidden.includes(e.account.source)),
    [entries, hidden],
  );
}
