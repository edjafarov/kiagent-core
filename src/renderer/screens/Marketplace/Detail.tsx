import React, { useEffect, useState } from 'react';
import Markdown from 'react-markdown';
import { useAppState } from '@renderer/state/app-state';
import { AccessRows, InstallSheet } from '@renderer/extensions/InstallSheet';
import { useExtensionInstall } from '@renderer/extensions/use-extension-install';
import { ExtGlyph } from '@renderer/components/ExtGlyph';
import type { PluginDetail } from '@shared/ipc';
import { bareGithubRef } from '@renderer/extensions/match';
import type { MarketplaceRow } from './rows';

/**
 * Marketplace detail pane — README, permissions, and the install / update /
 * review-consent / uninstall / enable actions for the selected row, all
 * through `useExtensionInstall` and `InstallSheet`.
 *
 * Mounted with `key={row.key}` from the list screen, so a selection change
 * always remounts fresh; the effect below is *also* keyed on `row.key`
 * (belt and braces) rather than the whole `row` object, since the parent
 * rebuilds `MarketplaceRow` objects on every AppState push (e.g. an
 * unrelated extension's status changing) without changing which row is
 * selected — refetching the README on every such push would be wasteful
 * and would flash the pane.
 *
 * Installed-ness/enabled/status always come from the live AppState
 * snapshot, not from `row.installed` (which is only as fresh as the last
 * time the list screen re-rendered): `installed` below is looked up by id
 * on every render.
 */
export function Detail(props: { row: MarketplaceRow }): React.ReactElement {
  const { row } = props;
  const [detail, setDetail] = useState<PluginDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const flow = useExtensionInstall();
  const { busy, error: actionError } = flow;

  const installed = useAppState((s) => s.extensions).find(
    (e) => e.id === row.installed?.id,
  );

  // The ref to preview/install against — normally the catalog's, but a
  // marketplace-origin row can be installed while absent from the catalog
  // (e.g. its repo's topic was dropped): fall back to the live installed
  // snapshot's own github: ref, stripped of its `@pin` suffix, so Update
  // still works. Anything else (no catalog, no github: installed ref —
  // e.g. a `file:` dev install) has nothing to install/update against.
  const installRef = row.catalog
    ? `github:${row.catalog.owner}/${row.catalog.repo}`
    : installed?.ref?.startsWith('github:')
      ? bareGithubRef(installed.ref)
      : undefined;

  useEffect(() => {
    let alive = true;
    setDetail(null);
    setDetailError(null);

    if (row.catalog) {
      const { owner, repo } = row.catalog;
      window.kiagent
        .invoke('marketplace:detail', { owner, repo })
        .then((d) => {
          if (alive) setDetail(d);
        })
        .catch((e: unknown) => {
          if (alive) setDetailError(e instanceof Error ? e.message : String(e));
        });
    }

    return () => {
      alive = false;
    };
    // Keyed on row.key only — see the doc comment above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [row.key]);

  function renderActions(): React.ReactNode {
    if (!installed) {
      if (detail?.latest?.tarballUrl) {
        return (
          <div className="mkt-actions">
            <button
              type="button"
              className="btn sm"
              disabled={busy}
              onClick={() => {
                if (installRef) void flow.preview(installRef, 'install');
              }}
            >
              Install
            </button>
          </div>
        );
      }
      if (detail) {
        return (
          <div className="mkt-actions">
            <button type="button" className="btn sm" disabled>
              No installable release yet
            </button>
          </div>
        );
      }
      return null;
    }

    let primary: React.ReactNode;
    if (installed.status === 'needs-consent') {
      primary = (
        <button
          type="button"
          className="btn sm"
          onClick={() => flow.review(installed)}
        >
          Review permissions
        </button>
      );
    } else if (row.updateAvailable && installRef) {
      primary = (
        <button
          type="button"
          className="btn sm"
          disabled={busy}
          onClick={() => void flow.preview(installRef, 'update')}
        >
          Update
        </button>
      );
    } else {
      primary = (
        <button type="button" className="btn sm" disabled>
          Installed
        </button>
      );
    }

    return (
      <div className="mkt-actions">
        {primary}
        <button
          type="button"
          className="btn ghost sm"
          disabled={busy}
          onClick={() => void flow.setEnabled(installed.id, !installed.enabled)}
        >
          {installed.enabled ? 'Disable' : 'Enable'}
        </button>
        {installed.origin !== 'bundled' && (
          <button
            type="button"
            className="btn destructive sm"
            disabled={busy}
            onClick={() => void flow.uninstall(installed.id)}
          >
            Uninstall
          </button>
        )}
      </div>
    );
  }

  const versionLine = [
    installed ? `installed v${installed.version}` : null,
    row.catalog ? `latest ${detail?.latest?.version ?? '—'}` : null,
  ]
    .filter((part): part is string => part !== null)
    .join(' · ');

  return (
    <>
      <div className="mkt-detail-head">
        <div className="mkt-detail-top">
          <div className="mkt-detail-title">
            <ExtGlyph
              name={row.title}
              iconDataUrl={
                installed?.iconDataUrl ??
                row.catalog?.iconDataUrl ??
                detail?.listing.iconDataUrl
              }
              size={40}
              boxed
            />
            <div className="mkt-header">
              <span className="h-section">{row.title}</span>
              {versionLine && <span className="t-meta">{versionLine}</span>}
            </div>
          </div>

          {renderActions()}
        </div>

        {installed?.status === 'errored' && installed.error && (
          <div className="mkt-error">{installed.error}</div>
        )}
        {actionError && <div className="mkt-error">{actionError}</div>}

        {installed && (
          <div className="mkt-caps">
            <AccessRows
              caps={installed.caps}
              oauthSources={installed.oauthSources}
              fileRoots={installed.fileRoots}
              addsPages={(installed.ui ?? []).length > 0}
            />
          </div>
        )}
      </div>

      {row.catalog &&
        (detail ? (
          <div className="mkt-readme">
            {detail.readmeMarkdown ? (
              <Markdown>{detail.readmeMarkdown}</Markdown>
            ) : (
              <p className="t-meta">No README.</p>
            )}
          </div>
        ) : detailError ? (
          <div className="mkt-error">{detailError}</div>
        ) : null)}

      {flow.consent && (
        <InstallSheet
          request={flow.consent}
          description={row.catalog?.description}
          readme={detail?.readmeMarkdown}
          onClose={flow.cancel}
          onConfirm={flow.commit}
        />
      )}
    </>
  );
}
