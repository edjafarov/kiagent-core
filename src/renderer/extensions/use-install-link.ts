// `kiagent://install` links (spec §8): main keeps one pending link and
// nudges; this takes it and routes to the Sources catalog, which opens the
// Add from GitHub sheet prefilled. Nothing is fetched until Continue.
import { useEffect, useRef } from 'react';
import { repoText } from '@shared/install-link';
import { useView } from '@renderer/state/view';

export function useInstallLink(): void {
  const nav = useView();
  const latest = useRef(nav);
  latest.current = nav;

  useEffect(() => {
    let alive = true;
    const take = (): void => {
      window.kiagent
        .invoke('extension:install-link-take', {})
        .then((r) => {
          if (!alive || !r) return;
          const { view, params, navigate, replaceParams } = latest.current;
          const linkParams = {
            add: '',
            link: repoText(r),
            linkSeq: String(r.seq),
          };
          // Already on Sources: keep the screen (and any open sheet) mounted.
          if (view === 'sources') replaceParams({ ...params, ...linkParams });
          else navigate('sources', linkParams);
        })
        .catch(() => {});
    };
    take();
    const off = window.kiagent.on('push:install-link', take);
    return () => {
      alive = false;
      off();
    };
  }, []);
}

/** Mount once inside the signed-in tree (core App and product shadows). */
export function InstallLinks(): null {
  useInstallLink();
  return null;
}
