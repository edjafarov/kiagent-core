import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { OutboxDraftDetail } from '@shared/ipc';
import {
  BrandGlyph,
  Busy,
  Button,
  Disclosure,
  KeyValue,
  Menu,
  Sheet,
  Status,
  TextButton,
  clientBrand,
  sourceBrand,
  type KeyValueItem,
  type MenuEntry,
} from '@shared/web-ui/ui';
import { formatRelativeCompact } from '@renderer/screens/Sources/format';
import {
  actionFor,
  defaultSendLater,
  mirrorLine,
  scheduledFor,
  sendPresets,
  statusWord,
  stripIpcWrapper,
  suggestedFor,
  whenLabel,
} from './outbox-rows';

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

export function fileSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
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
  onOpen: (draftId: string, notCarriedOver?: string[]) => void;
  /** Said once above the draft (what a Draft again left behind). */
  note?: string | null;
  onClose: () => void;
}): React.ReactElement {
  const { draftId } = props;
  const [detail, setDetail] = useState<OutboxDraftDetail | null | 'loading'>(
    'loading',
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmRedraft, setConfirmRedraft] = useState(false);
  /** "Custom time…" open: the picked local time (`datetime-local`). */
  const [later, setLater] = useState<string | null>(null);
  /** The Send ▾ menu. */
  const [menuOpen, setMenuOpen] = useState(false);
  const menuAnchor = useRef<HTMLButtonElement>(null);

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

  const send = (revision: number) =>
    act(async () => {
      const res = await window.kiagent.invoke('outbox:send', {
        draftId,
        revision,
      });
      if (res.outcome === 'changed' && res.row) {
        // Edited elsewhere (chat, the browser page, the mailbox) since this
        // sheet read it: show the new text, send nothing.
        read();
        setError('This draft changed — review it again.');
        return;
      }
      if (res.outcome === 'failed' && res.row?.status === 'draft') {
        // Couldn't reach the mail app first: nothing was sent and the draft
        // is as it was — Send again when it's back.
        setError(
          `Not sent — ${(res.error ?? 'try again').replace(/^not sent:\s*/, '')}`,
        );
        return;
      }
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

  // Try again on a provably-failed send: the same row back to review as a
  // new revision, so what goes out is what this sheet then shows.
  const reopen = () =>
    act(async () => {
      await window.kiagent.invoke('outbox:reopen', { draftId });
      read();
    });

  const redraft = () =>
    act(async () => {
      const fresh = await window.kiagent.invoke('outbox:redraft', { draftId });
      props.onOpen(fresh.draftId, fresh.notCarriedOver);
    });

  // Files: the user's own picks (main opens the dialog) or a removal, at the
  // revision this sheet shows — a draft that moved on is re-read instead.
  const editFiles = (
    run: () => Promise<{ detail: OutboxDraftDetail | null; changed: boolean }>,
  ) =>
    act(async () => {
      const res = await run();
      if (res.detail) setDetail(res.detail);
      if (res.changed) setError('This draft changed — review it again.');
    });
  const addFiles = (revision: number) =>
    editFiles(() =>
      window.kiagent.invoke('outbox:add-files', { draftId, revision }),
    );
  const removeFile = (revision: number, filename: string) =>
    editFiles(() =>
      window.kiagent.invoke('outbox:remove-files', {
        draftId,
        revision,
        filenames: [filename],
      }),
    );

  // Send later: a confirm of the revision shown, for a send at `when`
  // (null cancels). A draft that moved on is re-read instead.
  const schedule = (revision: number, when: string | null) =>
    act(async () => {
      const res = await window.kiagent.invoke('outbox:schedule', {
        draftId,
        revision,
        sendAt: when === null ? null : new Date(when).toISOString(),
      });
      if (res.detail) setDetail(res.detail);
      if (res.outcome === 'changed')
        setError('This draft changed — review it again.');
      else if (res.outcome === 'failed')
        setError(
          `Not scheduled — ${(res.error ?? 'try again').replace(/^not scheduled:\s*/, '')}`,
        );
      else setLater(null);
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
  const sendable = action === 'review';
  const source = props.sourceName(d.sourceId);
  // The list shows no word for a sent row; a single message says so.
  const word =
    d.status === 'sent'
      ? {
          label: `Sent${d.mirror?.sentElsewhere ? ` from ${d.mirror.provider ?? 'your mail app'}` : ''} ${formatRelativeCompact(d.sentAt)}`,
        }
      : statusWord(d);

  const email = d.bodyHtml !== undefined;
  const items: KeyValueItem[] = [
    ...(email ? [{ label: 'From', value: d.accountLabel }] : []),
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
    ...(d.bcc.length > 0 ? [{ label: 'Bcc', value: d.bcc.join(', ') }] : []),
    ...(!email ? [{ label: 'Sending account', value: d.accountLabel }] : []),
    ...(d.subject ? [{ label: 'Subject', value: d.subject }] : []),
  ];
  // Kia's own facts, one quiet line above the message.
  const meta = [`Drafted by ${draftedBy(d)}`, mirrorLine(d)]
    .filter(Boolean)
    .join(' · ');

  const nowMs = Date.now();
  const suggested =
    !d.sendAt &&
    d.suggestedSendAt &&
    Date.parse(d.suggestedSendAt) > nowMs + 60_000
      ? d.suggestedSendAt
      : null;
  const menuItems: MenuEntry[] = [
    ...(suggested
      ? ([
          {
            key: 'now',
            label: 'Send now',
            onSelect: () => void send(d.revision),
          },
          'separator',
        ] as MenuEntry[])
      : []),
    ...sendPresets(nowMs).map(
      (p): MenuEntry => ({
        key: p.key,
        label: (
          <span className="ob-preset">
            <span>{p.label}</span>
            <span className="ob-preset-at">{whenLabel(p.at, nowMs)}</span>
          </span>
        ),
        onSelect: () => void schedule(d.revision, new Date(p.at).toISOString()),
      }),
    ),
    'separator',
    {
      key: 'custom',
      label: 'Custom time…',
      onSelect: () => setLater(defaultSendLater(nowMs)),
    },
    ...(d.sendAt
      ? ([
          'separator',
          {
            key: 'cancel',
            label: 'Cancel schedule',
            onSelect: () => void schedule(d.revision, null),
          },
        ] as MenuEntry[])
      : []),
  ];
  const primary = d.sendAt
    ? { label: 'Send now', run: () => void send(d.revision) }
    : suggested
      ? {
          label: `Schedule for ${whenLabel(Date.parse(suggested), nowMs)}`,
          run: () => void schedule(d.revision, suggested),
        }
      : { label: 'Send', run: () => void send(d.revision) };

  let footer: React.ReactNode;
  if (sendable)
    footer = (
      <>
        <Button variant="ghost" disabled={busy} onClick={() => void discard()}>
          Discard
        </Button>
        <TextButton disabled={busy} onClick={() => void openInBrowser()}>
          Open in browser
        </TextButton>
        <span className="ob-split">
          <Button
            variant="primary"
            icon={suggested ? 'clock' : 'send'}
            disabled={busy}
            onClick={primary.run}
          >
            {busy ? 'Working…' : primary.label}
          </Button>
          <Button
            ref={menuAnchor}
            variant="primary"
            icon="chev-down"
            aria-label="More send options"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            disabled={busy}
            onClick={() => setMenuOpen((o) => !o)}
          />
        </span>
        <Menu
          open={menuOpen}
          anchorRef={menuAnchor}
          onClose={() => setMenuOpen(false)}
          items={menuItems}
          aria-label="Send options"
          placement="top-end"
        />
      </>
    );
  else if (action === 'retry')
    footer = (
      <Button variant="primary" disabled={busy} onClick={() => void reopen()}>
        Review again
      </Button>
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
      {props.note && <p className="ob-note">{props.note}</p>}
      <p className="ob-meta">{meta}</p>
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
      {email ? (
        <div
          className="ob-body ob-mail"
          // Core's rendering: raw HTML escaped, links http(s)/mailto only.
          // eslint-disable-next-line react/no-danger
          dangerouslySetInnerHTML={{ __html: d.bodyHtml! }}
          onClickCapture={(e) => {
            // A preview, not a browser: links show their target, never open.
            if ((e.target as HTMLElement).closest('a')) e.preventDefault();
          }}
        />
      ) : (
        <div className="ob-body">{d.body}</div>
      )}
      {(d.attachments.length > 0 || sendable) && (
        <ul className="ob-files" aria-label="Attachments">
          {d.attachments.map((a) => (
            <li key={a.filename} className="ob-file">
              <span className="ob-file-name">{a.filename}</span>
              <span className="ob-file-meta">
                {' '}
                · {fileSize(a.size)} · {a.origin}
              </span>
              {sendable && (
                <TextButton
                  disabled={busy}
                  aria-label={`Remove ${a.filename}`}
                  onClick={() => void removeFile(d.revision, a.filename)}
                >
                  Remove
                </TextButton>
              )}
            </li>
          ))}
          {sendable && (
            <li>
              <TextButton
                disabled={busy}
                onClick={() => void addFiles(d.revision)}
              >
                Add file…
              </TextButton>
            </li>
          )}
        </ul>
      )}
      {sendable && d.sendAt && (
        <p className="ob-schedule">
          {scheduledFor(d.sendAt)}{' '}
          <TextButton
            disabled={busy}
            onClick={() => void schedule(d.revision, null)}
          >
            Cancel schedule
          </TextButton>
        </p>
      )}
      {sendable && !d.sendAt && d.suggestedSendAt && (
        <p className="ob-schedule">
          {suggested
            ? suggestedFor(suggested, nowMs)
            : 'Suggested time passed — send now or pick a time'}
        </p>
      )}
      {sendable && !d.sendAt && d.note && <p className="ob-note">{d.note}</p>}
      {sendable && later !== null && (
        <p className="ob-schedule">
          <label>
            Send at{' '}
            <input
              type="datetime-local"
              value={later}
              onChange={(e) => setLater(e.target.value)}
              aria-label="Send at"
            />
          </label>{' '}
          <Button
            size="sm"
            variant="primary"
            disabled={busy || !later}
            onClick={() => void schedule(d.revision, later)}
          >
            Schedule
          </Button>{' '}
          <TextButton disabled={busy} onClick={() => setLater(null)}>
            Cancel
          </TextButton>
        </p>
      )}
      {error && <p className="ob-note is-err">{error}</p>}
      {sendable && (
        <p className="ob-note">
          {d.sendAt
            ? 'It goes at that time as it is now — any change cancels the schedule.'
            : 'Nothing is sent until you press Send.'}
        </p>
      )}
    </Sheet>
  );
}
