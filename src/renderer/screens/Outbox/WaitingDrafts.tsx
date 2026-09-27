import React from 'react';
import type { OutboxPanelRow } from '@shared/ipc';
import {
  AttentionList,
  AttentionRow,
  Button,
  sourceCategory,
} from '@shared/web-ui/ui';
import { formatRelativeCompact } from '@renderer/screens/Sources/format';
import { quoted } from './outbox-rows';
import type { RowActions } from './use-row-action';

/** A chat message is "Slack message to #design"; mail is "Sam · Subject". */
export function waitingTitle(r: OutboxPanelRow, source: string): string {
  if (sourceCategory(r.sourceId) === 'chat')
    return `${source} message to ${r.recipientDisplay}`;
  return r.subject
    ? `${r.recipientDisplay} · ${r.subject}`
    : r.recipientDisplay;
}

/** The drafts waiting for the user, each one row with its two actions.
 *  Discard is immediate — Draft again brings a discarded draft back. */
export function WaitingDrafts(props: {
  rows: readonly OutboxPanelRow[];
  sourceName: (sourceId: string) => string;
  actions: RowActions;
  onReview: (draftId: string) => void;
}): React.ReactElement {
  const { actions } = props;
  return (
    <AttentionList aria-label="Waiting for you">
      {props.rows.map((r) => {
        const source = props.sourceName(r.sourceId);
        const busy = actions.busyId === r.draftId;
        const failed = actions.error?.id === r.draftId;
        return (
          <AttentionRow
            key={r.draftId}
            tone="acc"
            kind="Review"
            title={waitingTitle(r, source)}
            sub={
              failed
                ? actions.error?.message
                : `${quoted(r.bodyPreview)} · ${source} · ${formatRelativeCompact(r.createdAt)}`
            }
            action={
              <>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() =>
                    void actions.run(r.draftId, () =>
                      window.kiagent.invoke('outbox:discard', {
                        draftId: r.draftId,
                      }),
                    )
                  }
                >
                  Discard
                </Button>
                <Button
                  size="sm"
                  variant="primary"
                  disabled={busy}
                  onClick={() => props.onReview(r.draftId)}
                >
                  Review &amp; send
                </Button>
              </>
            }
          />
        );
      })}
    </AttentionList>
  );
}
