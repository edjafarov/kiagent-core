import React from 'react';
import type { OutboxPanelRow } from '@shared/ipc';
import {
  BrandMark,
  Button,
  Card,
  CardHeader,
  DayGroup,
  EmptyState,
  Row,
  Rows,
  Status,
  TextButton,
  dayGroup,
  shortDay,
  sourceBrand,
  startOfWeek,
  type DayGroupName,
} from '@shared/web-ui/ui';
import { actionFor, isFaint, quoted, statusWord } from './outbox-rows';
import type { OutboxData } from './use-outbox';

/** The moment a row shows: when it went out, else when it was drafted. */
export function shownAt(r: OutboxPanelRow): number {
  return Date.parse(r.sentAt ?? r.createdAt);
}

/** Rows newest first by the time they show, split into day groups. */
function grouped(
  rows: readonly OutboxPanelRow[],
  now: number,
): Array<[DayGroupName, OutboxPanelRow[]]> {
  const out: Array<[DayGroupName, OutboxPanelRow[]]> = [];
  const sorted = [...rows].sort((a, b) => shownAt(b) - shownAt(a));
  for (const r of sorted) {
    const g = dayGroup(shownAt(r), now);
    const last = out[out.length - 1];
    if (last && last[0] === g) last[1].push(r);
    else out.push([g, [r]]);
  }
  return out;
}

/**
 * Sent & past drafts: one row per message in day groups — who it went to,
 * the words (or why it did not go), a status word only when it did not go
 * out, its one-click action, the source and the time. A row opens its
 * message, where everything else lives (the technical details, and Draft
 * again for a message that may already have arrived).
 */
export function History(props: {
  rows: readonly OutboxPanelRow[];
  now: number;
  sourceName: (sourceId: string) => string;
  actions: Pick<OutboxData, 'busyId' | 'error' | 'run'>;
  onOpen: (draftId: string) => void;
}): React.ReactElement {
  const { rows, now, actions } = props;

  const actionOf = (r: OutboxPanelRow): React.ReactNode => {
    const busy = actions.busyId === r.draftId;
    switch (actionFor(r)) {
      case 'retry':
        return (
          <Button
            size="sm"
            disabled={busy}
            onClick={() => props.onOpen(r.draftId)}
          >
            Try again
          </Button>
        );
      case 'redraft':
        return (
          <TextButton
            disabled={busy}
            onClick={() =>
              void actions.run(r.draftId, async () => {
                const { draftId } = await window.kiagent.invoke(
                  'outbox:redraft',
                  { draftId: r.draftId },
                );
                props.onOpen(draftId);
              })
            }
          >
            Draft again
          </TextButton>
        );
      default:
        return null;
    }
  };

  const allThisWeek =
    rows.length > 0 && rows.every((r) => shownAt(r) >= startOfWeek(now));

  return (
    <Card>
      <CardHeader
        label="Sent & past drafts"
        meta={allThisWeek ? 'this week' : undefined}
      />
      {rows.length === 0 ? (
        <EmptyState>
          Nothing sent yet — ask your AI app to draft a reply.
        </EmptyState>
      ) : (
        <Rows aria-label="Sent and past drafts">
          {grouped(rows, now).map(([group, items]) => (
            <React.Fragment key={group}>
              <DayGroup>{group}</DayGroup>
              {items.map((r) => {
                const word = statusWord(r);
                const action = actionOf(r);
                const source = props.sourceName(r.sourceId);
                const failure =
                  actions.error?.id === r.draftId
                    ? actions.error.message
                    : r.error;
                return (
                  <Row
                    key={r.draftId}
                    size={42}
                    faint={isFaint(r)}
                    lead={
                      <BrandMark
                        brand={sourceBrand(r.sourceId, { name: source })}
                        faint={isFaint(r)}
                      />
                    }
                    title={
                      <>
                        <b>{r.recipientDisplay}</b>
                        {r.subject ? ` · ${r.subject}` : ''}
                      </>
                    }
                    sub={failure ?? quoted(r.bodyPreview)}
                    trail={
                      word || action ? (
                        <span className="ob-trail">
                          {word &&
                            (word.tone ? (
                              <Status tone={word.tone}>{word.label}</Status>
                            ) : (
                              <span className="ob-word">{word.label}</span>
                            ))}
                          {action}
                        </span>
                      ) : undefined
                    }
                    time={`${source} · ${shortDay(shownAt(r), now)}`}
                    onClick={() => props.onOpen(r.draftId)}
                    aria-label={`Open the message to ${r.recipientDisplay}`}
                  />
                );
              })}
            </React.Fragment>
          ))}
        </Rows>
      )}
    </Card>
  );
}
