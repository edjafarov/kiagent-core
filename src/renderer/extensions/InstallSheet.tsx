import React, { useEffect, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import { Icon } from '@shared/web-ui/icon-sprite';
import {
  BrandGlyph,
  Button,
  Disclosure,
  KeyValue,
  Row,
  Rows,
  Sheet,
  sourceBrand,
  type KeyValueItem,
} from '@shared/web-ui/ui';
import type {
  Cap,
  DeclaredFileRoot,
  OAuthSourceBinding,
} from '@shared/contracts';
import {
  CAP_CATALOG,
  OAUTH_PROVIDER_INFO,
  groupOAuthSources,
} from '@renderer/components/cap-catalog';
import { storeBrandId } from './match';
import type { InstallMode, InstallRequest } from './use-extension-install';
import './InstallSheet.css';

/**
 * The consent sheet shown before an extension is installed or updated, and
 * when the user reviews an installed one. All three present the same list
 * and the same all-or-nothing confirmation: an update always re-consents,
 * because it can add access the user never agreed to.
 */

const PAGES_CONSENT_COPY =
  'Add pages to KIAgent — pages run with full access to the app';

const CONFIRM: Record<InstallMode, { idle: string; busy: string }> = {
  install: { idle: 'Install', busy: 'Installing…' },
  update: { idle: 'Update', busy: 'Updating…' },
  review: { idle: 'Allow', busy: 'Allowing…' },
};

function fmtSize(bytes?: number): string | null {
  if (bytes === undefined) return null;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function originWords(ref?: string): string | null {
  if (ref?.startsWith('github:')) return 'From the store';
  if (ref?.startsWith('file:')) return 'From a file on this computer';
  return null;
}

/** A store ref's brand (so a tile keeps its colour here); else the icon. */
function brandFor(r: InstallRequest): ReturnType<typeof sourceBrand> {
  const repo = r.ref?.startsWith('github:')
    ? r.ref.slice('github:'.length).split('@')[0].split('/')[1]
    : undefined;
  return sourceBrand(repo ? storeBrandId(repo) : r.id, {
    name: r.name,
    iconDataUrl: r.iconDataUrl,
  });
}

function Elevated(): React.ReactElement {
  return <span className="ext-elevated">Elevated</span>;
}

/** What an extension may do, one row each. Elevated rows say why. */
export function AccessRows(props: {
  caps: Cap[];
  oauthSources?: OAuthSourceBinding[];
  fileRoots?: DeclaredFileRoot[];
  addsPages?: boolean;
}): React.ReactElement {
  const oauth = groupOAuthSources(props.oauthSources ?? []);
  const roots = props.fileRoots ?? [];
  const none =
    !props.addsPages &&
    props.caps.length === 0 &&
    oauth.length === 0 &&
    roots.length === 0;
  if (none) {
    return <p className="ext-none">It needs no special access.</p>;
  }
  return (
    <Rows aria-label="It will be able to">
      {props.addsPages && (
        <Row
          lead={<Icon name="shield" size={14} />}
          title={PAGES_CONSENT_COPY}
          sub="Only install extensions from publishers you trust."
          trail={<Elevated />}
        />
      )}
      {props.caps.map((cap) => {
        const info = CAP_CATALOG[cap];
        const elevated = info.risk === 'elevated';
        return (
          <Row
            key={cap}
            lead={<Icon name={info.icon} size={14} />}
            title={info.label}
            sub={elevated ? info.description : undefined}
            trail={elevated ? <Elevated /> : undefined}
          />
        );
      })}
      {oauth.map(({ provider, ids }) => {
        const info = OAUTH_PROVIDER_INFO[provider];
        return (
          <Row
            key={`oauth-${provider}`}
            lead={<Icon name={info.icon} size={14} />}
            title={`Signs in with your ${info.label} account (${ids.join(', ')})`}
            sub={`You choose what it may see in the ${info.label} sign-in window.`}
            trail={<Elevated />}
          />
        );
      })}
      {roots.map((r) => (
        <Row
          key={`root-${r.id}`}
          lead={<Icon name="folder" size={14} />}
          title={
            <>
              Read everything in <code className="mono">{r.path}</code>
            </>
          }
          sub={r.purpose}
          trail={<Elevated />}
        />
      ))}
    </Rows>
  );
}

export function InstallSheet(props: {
  request: InstallRequest;
  /** The store's one-line description, when the caller has it. */
  description?: string;
  /** The developer's README, when the caller has it. */
  readme?: string | null;
  /** Overrides the idle primary label, e.g. "Install & connect". */
  confirmLabel?: string;
  onClose: () => void;
  onConfirm: () => unknown;
}): React.ReactElement {
  const { request: r, description, readme, onClose, onConfirm } = props;
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );

  const confirm = async (): Promise<void> => {
    setBusy(true);
    try {
      await onConfirm();
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const meta = [originWords(r.ref), `v${r.version}`]
    .filter(Boolean)
    .join(' · ');
  const size = fmtSize(r.sizeBytes);
  const facts: KeyValueItem[] = [
    { label: 'Version', value: `v${r.version}` },
    ...(size ? [{ label: 'Size', value: size }] : []),
    ...(r.ref
      ? [{ label: 'Source', value: <span className="mono">{r.ref}</span> }]
      : []),
    ...(r.integrity
      ? [
          {
            label: 'Integrity',
            value: <span className="mono">{r.integrity}</span>,
          },
        ]
      : []),
  ];

  return (
    <Sheet
      title={
        <span className="ext-sheet-id">
          <BrandGlyph brand={brandFor(r)} size={32} />
          <span className="ext-sheet-name">
            <span>{r.name}</span>
            <span className="ext-sheet-meta">{meta}</span>
          </span>
        </span>
      }
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={busy}
            onClick={() => void confirm()}
          >
            {busy
              ? CONFIRM[r.mode].busy
              : (props.confirmLabel ?? CONFIRM[r.mode].idle)}
          </Button>
        </>
      }
    >
      {description && <p className="ext-sheet-desc">{description}</p>}
      <h3 className="ext-sheet-label">It will be able to</h3>
      <div className="ext-access">
        <AccessRows
          caps={r.caps}
          oauthSources={r.oauthSources}
          fileRoots={r.fileRoots}
          addsPages={r.addsPages}
        />
      </div>
      <Disclosure label="Details from the developer">
        <KeyValue items={facts} />
        {readme && (
          <div className="ext-readme">
            <Markdown>{readme}</Markdown>
          </div>
        )}
      </Disclosure>
    </Sheet>
  );
}
