import React, { useEffect, useState } from 'react';
import type { ExtensionSnapshot } from '@shared/contracts';
import type { View, ViewParams } from '@renderer/state/view';
import { ContributedScreenBoundary } from '@renderer/screens/ContributedScreenBoundary';
import { ContributedUnavailable } from '@renderer/screens/ContributedUnavailable';

/**
 * Runtime loader for an extension's contributed page (`dist/ui/<id>.js`).
 * The page is trusted code — the user consented to it running with full
 * access to the app — imported from a blob URL and rendered with the host's
 * own React (`globalThis.__kiaHost`, set in index.tsx).
 */

export type PageProps = {
  params: ViewParams;
  navigate: (to: View, params?: ViewParams) => void;
};
export type PageModule = { default: React.ComponentType<PageProps> };
export type LoadModule = (source: string) => Promise<PageModule>;

export const blobImport: LoadModule = async (source) => {
  const url = URL.createObjectURL(
    new Blob([source], { type: 'text/javascript' }),
  );
  try {
    return (await import(/* webpackIgnore: true */ url)) as PageModule;
  } finally {
    URL.revokeObjectURL(url);
  }
};

/** A new version or a new activation of the extension is a new module. */
export const pageCacheKey = (
  ext: ExtensionSnapshot,
  contributionId: string,
): string =>
  `${ext.id}/${contributionId}@${ext.version}#${ext.activatedAt ?? ''}`;

const cache = new Map<string, Promise<PageModule>>();

/** Test-only. */
export function __resetPageCache(): void {
  cache.clear();
}

function load(
  ext: ExtensionSnapshot,
  contributionId: string,
  loadModule: LoadModule,
): Promise<PageModule> {
  const key = pageCacheKey(ext, contributionId);
  let p = cache.get(key);
  if (!p) {
    p = window.kiagent
      .invoke('extensions:ui-source', { extensionId: ext.id, contributionId })
      .then(({ source }) => loadModule(source));
    // A failed load is retried on the next visit.
    p.catch(() => cache.delete(key));
    cache.set(key, p);
  }
  return p;
}

type Props = PageProps & {
  ext: ExtensionSnapshot;
  contributionId: string;
  loadModule?: LoadModule;
};

function Loaded(props: Props & { loadModule: LoadModule }) {
  const { ext, contributionId, loadModule, params, navigate } = props;
  const [state, setState] = useState<{ mod?: PageModule; failed?: boolean }>(
    {},
  );
  useEffect(() => {
    let alive = true;
    load(ext, contributionId, loadModule).then(
      (mod) => {
        if (alive) setState({ mod });
      },
      (err) => {
        // eslint-disable-next-line no-console
        console.error(
          `[contributed-page] ${ext.name} failed to load ${contributionId}:`,
          err,
        );
        if (alive) setState({ failed: true });
      },
    );
    return () => {
      alive = false;
    };
    // The parent keys this component on the cache key, so the effect runs
    // exactly once per module identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (state.failed)
    return (
      <ContributedUnavailable extensionName={ext.name} reason="load-failed" />
    );
  if (!state.mod)
    return <ContributedUnavailable extensionName={ext.name} reason="loading" />;
  const Page = state.mod.default;
  return <Page params={params} navigate={navigate} />;
}

/** Keyed on the cache key: a new activation remounts both the loader and a
 *  boundary that had latched an error. */
export function ContributedPage(props: Props): React.ReactElement {
  const key = pageCacheKey(props.ext, props.contributionId);
  return (
    <ContributedScreenBoundary key={key} extensionName={props.ext.name}>
      <Loaded {...props} loadModule={props.loadModule ?? blobImport} />
    </ContributedScreenBoundary>
  );
}
