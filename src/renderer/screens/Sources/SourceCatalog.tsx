import React, { useEffect, useId, useRef, useState } from 'react';
import {
  BrandGlyph,
  Page,
  TextButton,
  TextField,
  Spinner,
} from '@shared/web-ui/ui';
import { useAppState } from '@renderer/state/app-state';
import { InstallSheet } from '@renderer/extensions/InstallSheet';
import { useExtensionInstall } from '@renderer/extensions/use-extension-install';
import { bareGithubRef } from '@renderer/extensions/match';
import { footerWords, type CatalogTile } from './catalog';
import { useCatalog } from './use-catalog';
import { useSourceDescriptors } from './sources-registry';
import './SourceCatalog.css';

function Tile(props: {
  tile: CatalogTile;
  disabled: boolean;
  onClick: () => void;
}): React.ReactElement {
  const { tile } = props;
  const footer = footerWords(tile.footer);
  return (
    <button
      type="button"
      className="src-tile"
      disabled={props.disabled}
      onClick={props.onClick}
    >
      <BrandGlyph brand={tile.brand} size={32} />
      <span className="src-tile-name">{tile.name}</span>
      {tile.sentence && (
        <span className="src-tile-sentence">{tile.sentence}</span>
      )}
      {footer && <span className="src-tile-foot">{footer}</span>}
    </button>
  );
}

function Section(props: {
  label: string;
  children: React.ReactNode;
}): React.ReactElement {
  const id = useId();
  return (
    <section className="src-cat-sec" aria-labelledby={id}>
      <h2 id={id} className="src-cat-lbl">
        {props.label}
      </h2>
      {props.children}
    </section>
  );
}

/**
 * Add a source: every source that can be connected now, then what the store
 * adds. A source tile starts its connect flow; a store tile opens the
 * install sheet, and "Install & connect" moves on to the new source's
 * connect flow once the extension is running and its source is listed.
 */
export function SourceCatalog(props: {
  onBack: () => void;
  onPick: (sourceId: string) => void;
  /** `owner/repo`: open that store item's install sheet on arrival. */
  install?: string;
}): React.ReactElement {
  const { onPick } = props;
  const [query, setQuery] = useState('');
  const catalog = useCatalog({ query });
  const flow = useExtensionInstall();
  const extensions = useAppState((s) => s.extensions);
  const descriptors = useSourceDescriptors();
  const [pending, setPending] = useState<{
    id: string;
    name: string;
    sourceId: string;
  } | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const installStarted = useRef(false);
  useEffect(() => {
    if (!props.install || installStarted.current) return;
    installStarted.current = true;
    void flow.preview(`github:${props.install}`, 'install');
    // Once, on arrival.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Install & connect: wait for the extension to run and its source to be
  // listed; a refusal to start drops the connect and says why.
  useEffect(() => {
    if (!pending) return;
    const ext = extensions.find((e) => e.id === pending.id);
    if (ext && ext.status !== 'activated' && ext.status !== 'activating') {
      setPending(null);
      setNote(
        ext.status === 'errored'
          ? `${ext.name} was installed but couldn’t start: ${ext.error ?? 'unknown error'}`
          : ext.status === 'needs-consent'
            ? `${ext.name} was installed and needs its permissions reviewed in Settings.`
            : `${ext.name} was installed and is turned off in Settings.`,
      );
      return;
    }
    if (
      ext?.status === 'activated' &&
      descriptors?.some((d) => d.id === pending.sourceId)
    ) {
      setPending(null);
      onPick(pending.sourceId);
    }
  }, [pending, extensions, descriptors, onPick]);

  const { consent } = flow;
  const listing =
    consent?.ref &&
    catalog.items.find(
      (i) => `github:${i.owner}/${i.repo}` === bareGithubRef(consent.ref!),
    );
  const connects = (consent?.sourceIds?.length ?? 0) > 0;

  const confirm = async (): Promise<void> => {
    const sourceId = consent?.sourceIds?.[0];
    const name = consent?.name ?? '';
    const r = await flow.commit();
    if (r.ok && r.id && sourceId) setPending({ id: r.id, name, sourceId });
  };

  const busy = flow.busy || pending !== null;
  const q = query.trim();
  const nothing =
    q !== '' &&
    catalog.sources?.length === 0 &&
    (catalog.store?.length ?? 0) === 0;

  return (
    <Page
      crumb={{
        parent: 'Sources',
        current: 'Add a source',
        onBack: props.onBack,
      }}
    >
      <div className="src-cat">
        <div className="src-cat-search">
          <TextField
            search
            type="search"
            aria-label="Search sources and extensions"
            placeholder="Search sources and extensions"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <p className="src-cat-note">
            Everything you connect stays on this computer.
          </p>
        </div>

        {pending && (
          <p role="status" className="src-cat-status">
            <Spinner /> Installing {pending.name}…
          </p>
        )}
        {note && (
          <p role="status" className="src-cat-status">
            {note}
          </p>
        )}
        {flow.error && (
          <p role="alert" className="src-cat-err">
            {flow.error}
          </p>
        )}
        {nothing && <p className="src-cat-note">Nothing matches “{q}”.</p>}

        {catalog.sources === null ? (
          <p className="src-cat-note">Loading sources…</p>
        ) : (
          catalog.sources.length > 0 && (
            <Section label="Sources">
              <div className="src-tiles">
                {catalog.sources.map((t) => (
                  <Tile
                    key={t.key}
                    tile={t}
                    disabled={busy}
                    onClick={() => {
                      if ('sourceId' in t.start) onPick(t.start.sourceId);
                    }}
                  />
                ))}
              </div>
            </Section>
          )
        )}

        {catalog.store === null ? (
          <Section label="From the store">
            <p className="src-cat-note">Loading the store…</p>
          </Section>
        ) : catalog.storeError ? (
          <Section label="From the store">
            <p className="src-cat-note">
              The store couldn’t be reached.{' '}
              <TextButton onClick={catalog.retryStore}>Try again</TextButton>
            </p>
          </Section>
        ) : (
          catalog.store.length > 0 && (
            <Section label="From the store">
              <div className="src-tiles">
                {catalog.store.map((t) => (
                  <Tile
                    key={t.key}
                    tile={t}
                    disabled={busy}
                    onClick={() => {
                      if ('item' in t.start) {
                        const { owner, repo } = t.start.item;
                        setNote(null);
                        void flow.preview(`github:${owner}/${repo}`, 'install');
                      }
                    }}
                  />
                ))}
              </div>
            </Section>
          )
        )}
      </div>

      {consent && (
        <InstallSheet
          request={consent}
          description={listing ? listing.description : undefined}
          confirmLabel={connects ? 'Install & connect' : undefined}
          busy={flow.busy}
          onClose={flow.cancel}
          onConfirm={() => void confirm()}
        />
      )}
    </Page>
  );
}
