import React from 'react';
import type { Account, DocumentId } from '@shared/contracts';
import { formatActivityTs } from '../format';

const MAX_EVENTS = 3;

interface RecentDoc {
  id: DocumentId;
  title: string | null;
  ts: string;
}

interface ActivityEvent {
  key: string;
  ts: string;
  text: string;
  level?: 'error';
}

/** `recent` has no document `type` (AppState's `recent` entry is just
 *  `{id, title, ts}` — contracts.ts) so, unlike the legacy per-connector
 *  INDEXED_LABEL map, this is a generic "Indexed — <title>" line rather
 *  than a source-specific verb ("Indexed email" / "Indexed doc" / …). */
function buildEvents(a: Account, recent: RecentDoc[]): ActivityEvent[] {
  const events: ActivityEvent[] = [];
  if (
    a.lastError &&
    (a.status === 'error' || a.status === 'needsReauth') &&
    a.lastSyncAt
  ) {
    events.push({
      key: `err:${a.lastSyncAt}`,
      ts: a.lastSyncAt,
      text: a.lastError,
      level: 'error',
    });
  }
  for (const doc of recent) {
    const title = doc.title?.trim();
    events.push({
      key: `doc:${doc.id}`,
      ts: doc.ts,
      text: title ? `Indexed — ${title}` : 'Indexed new document',
    });
  }
  const mostRecentDocTs = recent[0]?.ts ?? null;
  if (a.lastSyncAt && a.lastSyncAt !== mostRecentDocTs) {
    events.push({
      key: `sync:${a.lastSyncAt}`,
      ts: a.lastSyncAt,
      text: 'Synced',
    });
  }
  events.sort((x, y) => (x.ts < y.ts ? 1 : x.ts > y.ts ? -1 : 0));
  return events;
}

export function RecentActivity(props: {
  account: Account;
  recent: RecentDoc[];
}): React.ReactElement {
  const events = buildEvents(props.account, props.recent).slice(0, MAX_EVENTS);
  return (
    <section className="detail-card">
      <div className="lbl-section">Recent activity</div>
      {events.length === 0 ? (
        <div className="t-meta">No activity yet.</div>
      ) : (
        <ul className="ra-list">
          {events.map((e) => (
            <li
              key={e.key}
              className={e.level === 'error' ? 'ra-row ra-error' : 'ra-row'}
            >
              <span className="t-meta mono ra-ts">
                {formatActivityTs(e.ts)}
              </span>
              <span>{e.text}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
