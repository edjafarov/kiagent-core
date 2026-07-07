import React, { useEffect, useState } from 'react';
import { Icon } from '@shared/web-ui/icon-sprite';
import type { Cap, OAuthSourceBinding } from '@shared/contracts';
import {
  CAP_CATALOG,
  OAUTH_PROVIDER_INFO,
  groupOAuthSources,
} from './cap-catalog';
import { ExtGlyph } from './ExtGlyph';
import './ConsentModal.css';

/**
 * Consent/permissions dialog shown before an extension is installed, before
 * an update is applied, or when the user asks to review an already-installed
 * extension's permissions. All three modes present the SAME capability list
 * and require the SAME all-or-nothing confirmation — an update is not a
 * lesser event than an install: it always re-consents (Global Constraint 8),
 * because an update can add capabilities the user never agreed to.
 *
 * Chrome (header glyph, meta grid, sectioned body, footer bar) is ported
 * from the legacy InstallConsentModal's `icm-*` layout (kiagent-ref, still
 * vendored in alpha-cent). Async mechanics mirror `RemoveAccountModal`:
 * `onConfirm` may be async, so the modal stays open in a busy state
 * (cancel/escape/backdrop disabled) until it settles.
 */

const TITLES = {
  install: 'Install',
  update: 'Update',
  review: 'Review permissions for',
} as const;
const CONFIRM = {
  install: { idle: 'Install', busy: 'Installing…' },
  update: { idle: 'Update', busy: 'Updating…' },
  review: { idle: 'Grant permissions', busy: 'Granting…' },
} as const;

function fmtSize(bytes?: number): string | null {
  if (bytes === undefined) return null;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export interface ConsentRequest {
  mode: 'install' | 'update' | 'review';
  id: string;
  name: string;
  version: string;
  caps: Cap[];
  /** Sources that sign in through a platform OAuth provider — shown as
   *  permission rows alongside caps. */
  oauthSources?: OAuthSourceBinding[];
  sizeBytes?: number;
  integrity?: string | null;
  /** Manifest icon as a data URI (staged package or installed snapshot) —
   *  absent falls back to the letter glyph. */
  iconDataUrl?: string;
  ref?: string;
}

export function ConsentModal(props: {
  request: ConsentRequest;
  onCancel: () => void;
  onConfirm: () => void | Promise<void>;
}): React.ReactElement {
  const { request, onCancel, onConfirm } = props;
  const {
    mode,
    name,
    version,
    caps,
    oauthSources,
    sizeBytes,
    integrity,
    iconDataUrl,
    ref,
  } = request;
  const oauthRows = groupOAuthSources(oauthSources ?? []);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !busy) onCancel();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel, busy]);

  async function confirm(): Promise<void> {
    setBusy(true);
    try {
      await onConfirm();
    } finally {
      setBusy(false);
    }
  }

  const size = fmtSize(sizeBytes);
  const confirmLabel = busy ? CONFIRM[mode].busy : CONFIRM[mode].idle;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`${TITLES[mode]} ${name}`}
      onClick={busy ? undefined : onCancel}
      className="cm-backdrop"
    >
      <div onClick={(e) => e.stopPropagation()} className="cm-modal">
        <header className="cm-head">
          <ExtGlyph name={name} iconDataUrl={iconDataUrl} size={34} />
          <h3 className="cm-title">
            {TITLES[mode]} {name}
          </h3>
        </header>

        <div className="cm-body">
          <dl className="cm-meta">
            <dt>Version</dt>
            <dd>v{version}</dd>
            {size && (
              <>
                <dt>Size</dt>
                <dd>{size}</dd>
              </>
            )}
            {ref && (
              <>
                <dt>Source</dt>
                <dd className="mono trunc" title={ref}>
                  {ref}
                </dd>
              </>
            )}
            {integrity && (
              <>
                <dt>Integrity</dt>
                <dd className="mono trunc" title={integrity}>
                  {integrity}
                </dd>
              </>
            )}
          </dl>

          <div className="cm-perms">
            <div className="cm-perms-label">Permissions</div>
            {caps.length === 0 && oauthRows.length === 0 ? (
              <div className="t-meta">
                This extension requests no capabilities.
              </div>
            ) : (
              <div className="cm-caps">
                {caps.map((cap) => {
                  const info = CAP_CATALOG[cap];
                  const elevated = info.risk === 'elevated';
                  return (
                    <div
                      key={cap}
                      className={
                        elevated ? 'cm-cap-row elevated' : 'cm-cap-row'
                      }
                    >
                      <Icon name={info.icon} size={14} />
                      <div className="cm-cap-text">
                        <div className="cm-cap-label">
                          {info.label}
                          {elevated && (
                            <span className="cm-elevated-tag">
                              <Icon name="shield" size={12} />
                              Elevated
                            </span>
                          )}
                        </div>
                        <div className="t-meta">{info.description}</div>
                      </div>
                    </div>
                  );
                })}
                {oauthRows.map(({ provider, ids }) => {
                  const info = OAUTH_PROVIDER_INFO[provider];
                  return (
                    <div
                      key={`oauth-${provider}`}
                      className="cm-cap-row elevated"
                    >
                      <Icon name={info.icon} size={14} />
                      <div className="cm-cap-text">
                        <div className="cm-cap-label">
                          Signs in with your {info.label} account (
                          {ids.join(', ')})
                          <span className="cm-elevated-tag">
                            <Icon name="shield" size={12} />
                            Elevated
                          </span>
                        </div>
                        <div className="t-meta">
                          Connecting opens a {info.label} sign-in window. The
                          extension chooses which {info.label} permissions to
                          request — review them there before approving.
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <p className="cm-note">
            Extensions run with access to your data and this machine. Only
            install ones you trust.
          </p>
        </div>

        <footer className="cm-foot">
          <button
            type="button"
            className="btn ghost"
            disabled={busy}
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={busy}
            onClick={() => void confirm()}
          >
            {busy && <span className="spinner" aria-hidden="true" />}
            {confirmLabel}
          </button>
        </footer>
      </div>
    </div>
  );
}
