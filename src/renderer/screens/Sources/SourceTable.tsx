import React, { useCallback } from 'react';
import type { Account, AccountId } from '@shared/contracts';
import { StatusPill } from './StatusPill';
import { AccountRowActions } from './AccountRowActions';
import { connectorMeta, sourceLabel } from './connector-meta';
import { SourceIcon } from './SourceIcon';
import { useSourceDescriptors } from './sources-registry';
import { formatRelativeCompact } from './format';
import { trackedFolderPaths } from './sections/TrackedFolders';

export interface SourceTableEntry {
  account: Account;
  docCount: number;
  lastDocumentAt: string | undefined;
}

function stopPropagation(e: React.MouseEvent): void {
  e.stopPropagation();
}

/**
 * The "Account / path" column identifies a row by `account.identifier` —
 * meaningless for local-folder, whose identifier is the fixed
 * `this-machine` marker (one shared account for every tracked root, see
 * `local-folder-source.ts`). Show the root count instead, matching the
 * "N folders"/"N sources" pluralization style already used in
 * `SourcesList`'s header line.
 *
 * A legacy account (pre-multi-root: no `config.paths` array) has an empty
 * path list — `trackedFolderPaths` can't recover a root from it (see
 * `getRootPaths`'s hard-cutover doc in `local-folder-source.ts`). Rendering
 * "0 folders" for it would hide the one identifying string this column used
 * to carry: the folder path itself, stored as `identifier` pre-multi-root.
 * Fall back to that raw identifier whenever the derived list is empty.
 */
function identifierLabel(a: Account): string {
  if (a.source !== 'local-folder') return a.identifier;
  const paths = trackedFolderPaths(a);
  if (paths.length === 0) return a.identifier;
  const n = paths.length;
  return `${n} ${n === 1 ? 'folder' : 'folders'}`;
}

const SourceRow = React.memo(function SourceRow(props: {
  entry: SourceTableEntry;
  label: string;
  onRowClick: (accountId: AccountId) => void;
}): React.ReactElement {
  const { entry, label, onRowClick } = props;
  const a = entry.account;
  const meta = connectorMeta(a.source);
  const handleClick = useCallback(() => onRowClick(a.id), [onRowClick, a.id]);
  return (
    <tr
      role="row"
      aria-label={a.identifier}
      className="src-row"
      onClick={handleClick}
    >
      <td>
        <div className="src-source-cell">
          <span className={`src-stripe ${meta.tag}`} />
          <SourceIcon
            sourceId={a.source}
            size={12}
            style={{ color: 'var(--text-secondary)' }}
          />
          <span className="src-source-label">{label}</span>
        </div>
      </td>
      <td className="mono src-identifier-cell" title={identifierLabel(a)}>
        {identifierLabel(a)}
      </td>
      <td>
        <StatusPill account={a} />
      </td>
      <td className="mono" style={{ fontSize: 11.5 }}>
        {entry.docCount.toLocaleString()}
      </td>
      <td className="t-meta">{formatRelativeCompact(entry.lastDocumentAt)}</td>
      <td onClick={stopPropagation}>
        <AccountRowActions
          account={a}
          buttonStyle={{ width: 20, height: 20 }}
        />
      </td>
    </tr>
  );
});

export function SourceTable(props: {
  entries: SourceTableEntry[];
  onRowClick: (accountId: AccountId) => void;
}): React.ReactElement {
  const descriptors = useSourceDescriptors();
  return (
    <div className="tbl-container">
      <table className="tbl">
        <thead>
          <tr>
            <th style={{ width: 110 }}>Source</th>
            <th>Account / path</th>
            <th style={{ width: 140 }}>Status</th>
            <th style={{ width: 140 }}>Indexed</th>
            <th style={{ width: 80 }}>Last</th>
            <th style={{ width: 36 }} aria-label="Actions" />
          </tr>
        </thead>
        <tbody>
          {props.entries.map((entry) => (
            <SourceRow
              key={entry.account.id}
              entry={entry}
              label={sourceLabel(entry.account.source, descriptors)}
              onRowClick={props.onRowClick}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}
