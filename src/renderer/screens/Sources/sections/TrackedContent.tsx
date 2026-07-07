import React, { useEffect, useState } from 'react';
import type { Account, Document } from '@shared/contracts';
import { Icon } from '@shared/web-ui/icon-sprite';
import { formatRelativeCompact, humanizeDocType } from '../format';

const PAGE_SIZE = 20;

/**
 * "Tracked content" for an account. The legacy section (ui-inventory.md
 * §2.3.2) is folder/root-based (`tracked_roots`, a resource-picker wizard
 * step) — the new `Account`/`Source` contracts have no such concept
 * (contracts.ts: an account is just `{source, identifier, config}`, and
 * documents form a parent/child tree via `Document.parentId`, not a
 * folder-root list). Per the task brief this section is rebuilt on the data
 * that DOES exist: a paginated browse of the account's own documents via
 * `search:query`, with `docs:children` expansion per row.
 */
export function TrackedContent(props: {
  account: Account;
}): React.ReactElement {
  const { account } = props;
  const [offset, setOffset] = useState(0);
  const [docs, setDocs] = useState<Document[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDocs(null);
    setError(null);
    window.kiagent
      .invoke('search:query', { account: account.id, limit: PAGE_SIZE, offset })
      .then((res) => {
        if (!cancelled) setDocs(res);
      })
      .catch((err) => {
        if (!cancelled)
          setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [account.id, offset]);

  return (
    <section className="detail-card">
      <div className="lbl-section">Tracked content</div>
      {error ? (
        <div className="si-error">{error}</div>
      ) : docs === null ? (
        <div className="t-meta" style={{ margin: '4px 0' }}>
          Loading…
        </div>
      ) : docs.length === 0 && offset === 0 ? (
        <div className="t-meta" style={{ margin: '4px 0' }}>
          Nothing indexed for this account yet.
        </div>
      ) : (
        <>
          <ul className="tc-list">
            {docs.map((d) => (
              <DocRow key={d.id} doc={d} />
            ))}
          </ul>
          <div className="tc-pager">
            <button
              type="button"
              className="btn ghost sm"
              disabled={offset === 0}
              onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
            >
              ← Newer
            </button>
            <span className="t-meta">
              {offset + 1}–{offset + docs.length}
            </span>
            <button
              type="button"
              className="btn ghost sm"
              disabled={docs.length < PAGE_SIZE}
              onClick={() => setOffset(offset + PAGE_SIZE)}
            >
              Older →
            </button>
          </div>
        </>
      )}
    </section>
  );
}

function DocRow(props: { doc: Document }): React.ReactElement {
  const { doc } = props;
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<Document[] | null>(null);

  function toggle(): void {
    const next = !expanded;
    setExpanded(next);
    if (next && children === null) {
      window.kiagent
        .invoke('docs:children', { id: doc.id })
        .then(setChildren)
        .catch(() => setChildren([]));
    }
  }

  return (
    <li className="tc-row">
      <div className="tc-row-main" onClick={toggle} role="button" tabIndex={0}>
        <Icon
          name={expanded ? 'chev-down' : 'chev-right'}
          size={12}
          style={{ color: 'var(--text-tertiary)' }}
        />
        <Icon
          name="file"
          size={13}
          style={{ color: 'var(--text-secondary)' }}
        />
        <span className="tc-title">{doc.title?.trim() || '(untitled)'}</span>
        <span className="tc-type">{humanizeDocType(doc.type)}</span>
        <span className="t-meta mono tc-ts">
          {formatRelativeCompact(doc.updatedAt)}
        </span>
      </div>
      {expanded && <ChildList docs={children} />}
    </li>
  );
}

function ChildList(props: { docs: Document[] | null }): React.ReactElement {
  if (props.docs === null) {
    return <div className="t-meta tc-children-empty">Loading…</div>;
  }
  if (props.docs.length === 0) {
    return <div className="t-meta tc-children-empty">No nested items.</div>;
  }
  return (
    <ul className="tc-children">
      {props.docs.map((c) => (
        <li key={c.id} className="tc-child-row">
          <Icon
            name="file"
            size={12}
            style={{ color: 'var(--text-tertiary)' }}
          />
          <span className="tc-title">{c.title?.trim() || '(untitled)'}</span>
          <span className="tc-type">{humanizeDocType(c.type)}</span>
          <span className="t-meta mono tc-ts">
            {formatRelativeCompact(c.updatedAt)}
          </span>
        </li>
      ))}
    </ul>
  );
}
