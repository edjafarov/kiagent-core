import React, { useCallback, useEffect, useState } from 'react';
import type { OutboxDraftDetail } from '@shared/ipc';
import {
  BrandGlyph,
  Busy,
  Button,
  Disclosure,
  KeyValue,
  Sheet,
  Status,
  TextButton,
  clientBrand,
  sourceBrand,
  type KeyValueItem,
} from '@shared/web-ui/ui';
import { formatRelativeCompact } from '@renderer/screens/Sources/format';
import { actionFor, statusWord, stripIpcWrapper } from './outbox-rows';

/** Who drafted it: the app that asked, the user (Draft again), or an app
 *  that never named itself (rows older than the column, stdio clients). */
export function draftedBy(d: OutboxDraftDetail): string {
  const who =
    d.createdVia === 'panel'
      ? 'You, from the Outbox'
      : d.createdBy
        ? clientBrand(d.createdBy).name
        : 'An AI app';
  return `${who} · ${formatRelativeCompact(d.createdAt)}`;
}

function errorText(e: unknown): string {
  return stripIpcWrapper(e instanceof Error ? e.message : String(e));
}

/**
 * One message in full. A waiting draft (or a failure that provably never
 * went out) can be sent from here: Send runs the page confirm's own gate in
 * main (`outbox:send`), so a second Send, a browser confirm or an expiry in
 * between ends as "already" — never a second message. Any other message
 * opens read-only, with why it did not go and its technical details; Draft
 * again (behind a confirmation when it may already have arrived) opens the
 * fresh draft here.
 */
export function ReviewSheet(props: {
  draftId: string;
  sourceName: (sourceId: string) => string;
  /** Opens another message (the fresh draft after Draft again). */
  onOpen: (draftId: string) => void;
  onClose: () => void;
}): React.ReactElement {
  const { draftId } = props;
  const [detail, setDetail] = useState<OutboxDraftDetail | null | 'loading'>(
    'loading',
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmRedraft, setConfirmRedraft] = useState(false);

  const read = useCallback(() => {
    void window.kiagent
      .invoke('outbox:get', { draftId })
      .then(setDetail)
      .catch((e) => {
        setDetail(null);
        setError(errorText(e));
      });
  }, [draftId]);

  useEffect(() => {
    read();
    // A send from the browser page, or an expiry, while this is open.
    return window.kiagent.on('push:outbox-changed', read);
  }, [read]);

  const act = async (run: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await run();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const send = () =>
    act(async () => {
      const res = await window.kiagent.invoke('outbox:send', { draftId });
      if (
        res.outcome === 'failed' &&
        res.row &&
        detail &&
        detail !== 'loading'
      ) {
        // Stay open on the failure: its words and details show in place,
        // and Send stays only if it provably never went out.
        setDetail({ ...detail, ...res.row });
        return;
      }
      props.onClose(); // sent, or it was already sent / gone meanwhile
    });

  const discard = () =>
    act(async () => {
      await window.kiagent.invoke('outbox:discard', { draftId });
      props.onClose();
    });

  const redraft = () =>
    act(async () => {
      const fresh = await window.kiagent.invoke('outbox:redraft', { draftId });
      props.onOpen(fresh.draftId);
    });

  const openInBrowser = () =>
    act(() => window.kiagent.invoke('outbox:open-confirm', { draftId }));

  if (detail === 'loading' || detail === null) {
    return (
      <Sheet title="Message" onClose={props.onClose} width={640}>
        {detail === 'loading' ? (
          <Busy label="Opening the message…" />
        ) : (
          <p>{error ?? 'This message is no longer in the outbox.'}</p>
        )}
      </Sheet>
    );
  }

  const d = detail;
  const action = actionFor(d);
  const sendable = action === 'review' || action === 'retry';
  const source = props.sourceName(d.sourceId);
  // The list shows no word for a sent row; a single message says so.
  const word =
    d.status === 'sent'
      ? { label: `Sent ${formatRelativeCompact(d.sentAt)}` }
      : statusWord(d);

  const items: KeyValueItem[] = [
    {
      label: 'To',
      value: (
        <span className="ob-to">
          <BrandGlyph
            brand={sourceBrand(d.sourceId, { name: source })}
            size={20}
          />
          {d.to.length > 0 ? d.to.join(', ') : d.recipientDisplay}
          <span className="ob-to-via">
            {' '}
            · {source} ({d.accountLabel})
          </span>
        </span>
      ),
    },
    ...(d.cc.length > 0 ? [{ label: 'Cc', value: d.cc.join(', ') }] : []),
    { label: 'Drafted by', value: draftedBy(d) },
    { label: 'Sending account', value: d.accountLabel },
    ...(d.subject ? [{ label: 'Subject', value: d.subject }] : []),
  ];

  let footer: React.ReactNode;
  if (sendable)
    footer = (
      <>
        {action === 'review' && (
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => void discard()}
          >
            Discard
          </Button>
        )}
        <TextButton disabled={busy} onClick={() => void openInBrowser()}>
          Open in browser
        </TextButton>
        <Button
          variant="primary"
          icon="send"
          disabled={busy}
          onClick={() => void send()}
        >
          {busy ? 'Sending…' : 'Send'}
        </Button>
      </>
    );
  else if (action === 'redraft')
    footer = (
      <Button variant="primary" disabled={busy} onClick={() => void redraft()}>
        Draft again
      </Button>
    );
  else if (action === 'redraft-guarded' && confirmRedraft)
    // The warning sits beside the button it guards, never scrolled away.
    footer = (
      <>
        <span className="ob-foot-warn">
          It may already have been delivered — check the Sent folder first.
        </span>
        <Button
          variant="primary"
          disabled={busy}
          onClick={() => void redraft()}
        >
          Draft again anyway
        </Button>
      </>
    );
  else if (action === 'redraft-guarded')
    footer = (
      <Button disabled={busy} onClick={() => setConfirmRedraft(true)}>
        Draft again
      </Button>
    );
  else footer = <Button onClick={props.onClose}>Close</Button>;

  return (
    <Sheet
      title={d.status === 'draft' ? 'Review message' : 'Message'}
      onClose={props.onClose}
      busy={busy}
      width={640}
      footer={footer}
    >
      <KeyValue items={items} />
      {word && (
        <div className="ob-state">
          {word.tone ? (
            <Status tone={word.tone}>{word.label}</Status>
          ) : (
            <span className="ob-word">{word.label}</span>
          )}
          {d.error && <span> — {d.error}</span>}
        </div>
      )}
      {d.errorDetail && (
        <Disclosure label="Technical details">
          <code className="ob-detail">{d.errorDetail}</code>
        </Disclosure>
      )}
      <div className="ob-body">{d.body}</div>
      {error && <p className="ob-note is-err">{error}</p>}
      {sendable && (
        <p className="ob-note">Nothing is sent until you press Send.</p>
      )}
    </Sheet>
  );
}
