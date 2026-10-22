/**
 * docs_calendar_events backs calendarIndex.overlap() — find_free_time, the
 * event review page's day view, and the duplicate / similar-event checks
 * when drafting. Without it every call reads every live document of the
 * corpus (a 14 GB dev profile: 1.5–3 s cold), which blew the review page's
 * 1.5 s deadline and dropped the day view. Plans are asserted WITHOUT
 * ANALYZE: production corpora carry no sqlite_stat1.
 */
import Database from 'better-sqlite3';

import { overlapSql } from '../calendar-index';
import { migrate } from '../schema';

function planDetail(
  db: Database.Database,
  sql: string,
  params: unknown[],
): string {
  return (
    db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{
      detail: string;
    }>
  )
    .map((r) => r.detail)
    .join(' | ');
}

describe('calendarIndex.overlap uses docs_calendar_events', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    migrate(db);
  });

  afterEach(() => db.close());

  it('migrate() builds the partial expression index', () => {
    const row = db
      .prepare(`SELECT sql FROM sqlite_master WHERE type='index' AND name=?`)
      .get('docs_calendar_events') as { sql: string } | undefined;
    expect(row?.sql).toBe(
      `CREATE INDEX docs_calendar_events ON documents(julianday(json_extract(metadata, '$.end')), julianday(created_at), account_id) WHERE type = 'calendar.event' AND archived_at IS NULL`,
    );
  });

  it.each([
    ['all accounts', { account: false, limit: false }],
    ['all accounts, limited', { account: false, limit: true }],
    ['one account', { account: true, limit: false }],
  ])('plans %s onto the index', (_label, opts) => {
    const params = [
      '2026-11-29T00:00:00Z',
      '2026-11-28T00:00:00Z',
      ...(opts.account ? ['acc-1'] : []),
      ...(opts.limit ? [1001] : []),
    ];
    expect(planDetail(db, overlapSql(opts), params)).toContain(
      'USING INDEX docs_calendar_events',
    );
  });
});
