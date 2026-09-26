import React, { useEffect, useRef, useState } from 'react';
import type { ExtensionSnapshot } from '@shared/contracts';
import type { UpdateInfo } from '@shared/ipc';
import {
  AttentionList,
  AttentionRow,
  BrandGlyph,
  Button,
  ConfirmSheet,
  IconButton,
  Menu,
  Row,
  Rows,
  SettingsGroup,
  TextButton,
} from '@shared/web-ui/ui';
import { useAppState } from '@renderer/state/app-state';
import { useView } from '@renderer/state/view';
import { accessLine } from '@renderer/extensions/access-line';
import { extensionBrand } from '@renderer/extensions/brand';
import {
  AccessRows,
  InstallSheet,
  StoreReadme,
} from '@renderer/extensions/InstallSheet';
import { bareGithubRef } from '@renderer/extensions/match';
import {
  useExtensionInstall,
  type ExtensionInstall,
} from '@renderer/extensions/use-extension-install';
import './Extensions.css';

/** An update entry is only as fresh as the check that produced it: once the
 *  installed version moves off the one it compared, it is spent. */
function pendingUpdates(
  updates: readonly UpdateInfo[],
  installed: readonly ExtensionSnapshot[],
): Array<{ update: UpdateInfo; ext: ExtensionSnapshot }> {
  return updates.flatMap((update) => {
    const ext = installed.find(
      (e) => e.id === update.id && e.version === update.installedVersion,
    );
    return ext ? [{ update, ext }] : [];
  });
}

function rowSub(e: ExtensionSnapshot): React.ReactNode {
  if (e.status === 'errored')
    return (
      <span className="set-ext-err">{e.error ?? 'It couldn’t start.'}</span>
    );
  return e.enabled ? accessLine(e) : `Turned off · ${accessLine(e)}`;
}

function ExtensionMenu(props: {
  ext: ExtensionSnapshot;
  flow: ExtensionInstall;
  onDetails: () => void;
}): React.ReactElement {
  const { ext, flow } = props;
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [uninstalling, setUninstalling] = useState(false);
  return (
    <>
      <IconButton
        ref={anchor}
        icon="more"
        label={`${ext.name} actions`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      />
      <Menu
        open={open}
        anchorRef={anchor}
        onClose={() => setOpen(false)}
        aria-label={`${ext.name} actions`}
        placement="bottom-end"
        items={[
          {
            key: 'toggle',
            label: ext.enabled ? 'Turn off' : 'Turn on',
            icon: ext.enabled ? 'pause' : 'play',
            disabled: flow.busy,
            onSelect: () => void flow.setEnabled(ext.id, !ext.enabled),
          },
          {
            key: 'details',
            label: 'Details',
            icon: 'info',
            onSelect: props.onDetails,
          },
          'separator',
          {
            key: 'uninstall',
            label: 'Uninstall',
            icon: 'trash',
            danger: true,
            disabled: flow.busy,
            onSelect: () => setUninstalling(true),
          },
        ]}
      />
      {uninstalling && (
        <ConfirmSheet
          title={`Uninstall ${ext.name}?`}
          confirmLabel="Uninstall"
          busyLabel="Uninstalling…"
          tone="danger"
          onConfirm={() => flow.uninstall(ext.id)}
          onClose={() => setUninstalling(false)}
        >
          It stops running and leaves this computer. You can install it again
          from the catalog.
        </ConfirmSheet>
      )}
    </>
  );
}

/** One extension: who it is, what it may do, and its store README. */
function ExtensionDetails(props: {
  ext: ExtensionSnapshot;
  onBack: () => void;
}): React.ReactElement {
  const { ext } = props;
  return (
    <>
      <div>
        <TextButton onClick={props.onBack}>← Extensions</TextButton>
      </div>
      <div className="set-ext-head">
        <BrandGlyph brand={extensionBrand(ext)} size={32} />
        <div>
          <h2 className="ui-set-title">{ext.name}</h2>
          <p className="set-ext-meta">{accessLine(ext)}</p>
        </div>
      </div>
      <SettingsGroup title="It can">
        <AccessRows
          caps={ext.caps}
          oauthSources={ext.oauthSources}
          fileRoots={ext.fileRoots}
          addsPages={(ext.ui ?? []).length > 0}
        />
      </SettingsGroup>
      {ext.ref && <StoreReadme storeRef={ext.ref} />}
    </>
  );
}

/**
 * Settings › Extensions: what is installed (built-in parts aren't listed),
 * what can be updated — each on its own, through the install sheet, since
 * an update can ask for new access — and each extension's switch, details
 * and uninstall. New ones come from the Sources catalog.
 */
export function Extensions(): React.ReactElement {
  const extensions = useAppState((s) => s.extensions);
  const { navigate } = useView();
  const flow = useExtensionInstall();
  const [updates, setUpdates] = useState<UpdateInfo[]>([]);
  const [detailsId, setDetailsId] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    window.kiagent
      .invoke('marketplace:check-updates', undefined)
      .then((list) => {
        if (alive) setUpdates(list);
      })
      .catch(() => {
        // Best effort: no updates shown.
      });
    return () => {
      alive = false;
    };
  }, []);

  const installed = extensions.filter((e) => e.origin !== 'bundled');
  const pending = pendingUpdates(updates, installed);
  const details = installed.find((e) => e.id === detailsId);

  if (details) {
    return <ExtensionDetails ext={details} onBack={() => setDetailsId(null)} />;
  }

  return (
    <>
      <h2 className="ui-set-title">Extensions</h2>
      {pending.length > 0 && (
        <AttentionList aria-label="Updates">
          {pending.map(({ update, ext }) => (
            <AttentionRow
              key={ext.id}
              tone="acc"
              kind="Update"
              title={`${ext.name} ${update.latestVersion}`}
              sub={`You have v${update.installedVersion}`}
              action={
                <Button
                  size="sm"
                  variant="primary"
                  disabled={flow.busy}
                  onClick={() =>
                    void flow.preview(bareGithubRef(update.ref), 'update')
                  }
                >
                  Update
                </Button>
              }
            />
          ))}
        </AttentionList>
      )}
      {flow.error && (
        <p role="alert" className="set-ext-err">
          {flow.error}
        </p>
      )}
      <SettingsGroup
        title={
          <>
            Installed <span className="set-ext-count">{installed.length}</span>
          </>
        }
      >
        {installed.length === 0 ? (
          <p className="set-ext-none">No extensions installed yet.</p>
        ) : (
          <Rows aria-label="Installed extensions">
            {installed.map((e) => (
              <Row
                key={e.id}
                size={42}
                faint={!e.enabled}
                lead={<BrandGlyph brand={extensionBrand(e)} size={24} />}
                title={e.name}
                sub={rowSub(e)}
                trail={
                  <>
                    {e.status === 'needs-consent' && (
                      <Button size="sm" onClick={() => flow.review(e)}>
                        Review permissions
                      </Button>
                    )}
                    <ExtensionMenu
                      ext={e}
                      flow={flow}
                      onDetails={() => setDetailsId(e.id)}
                    />
                  </>
                }
              />
            ))}
          </Rows>
        )}
      </SettingsGroup>
      <div className="set-ext-foot">
        <p>Built-in parts aren’t listed.</p>
        <TextButton onClick={() => navigate('sources', { add: '' })}>
          Browse all extensions
        </TextButton>
      </div>
      {flow.consent && (
        <InstallSheet
          request={flow.consent}
          busy={flow.busy}
          onClose={flow.cancel}
          onConfirm={() => void flow.commit()}
        />
      )}
    </>
  );
}
