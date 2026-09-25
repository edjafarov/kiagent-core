import React from 'react';
import { cx } from './cx';

export interface DataColumn<T> {
  key: string;
  header: React.ReactNode;
  /** CSS width for the column, e.g. '120px' or '30%'. */
  width?: string;
  align?: 'left' | 'right';
  cell: (row: T) => React.ReactNode;
}

/** A real table with caps headers, 36px rows, no lines. Cells truncate;
 *  the table never scrolls sideways. */
export function DataTable<T>(props: {
  'aria-label': string;
  columns: readonly DataColumn<T>[];
  rows: readonly T[];
  rowKey: (row: T) => string;
  selectedKey?: string | null;
  onRowClick?: (row: T) => void;
  faint?: (row: T) => boolean;
}): React.ReactElement {
  const { columns, rows, rowKey, selectedKey, onRowClick, faint } = props;
  const hasWidths = columns.some((c) => c.width);
  return (
    <table className="ui-tbl" aria-label={props['aria-label']}>
      {hasWidths && (
        <colgroup>
          {columns.map((c) => (
            <col key={c.key} style={c.width ? { width: c.width } : undefined} />
          ))}
        </colgroup>
      )}
      <thead>
        <tr>
          {columns.map((c) => (
            <th
              key={c.key}
              scope="col"
              className={cx(c.align === 'right' && 'is-right')}
            >
              {c.header}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          const key = rowKey(row);
          const selected = selectedKey != null && key === selectedKey;
          return (
            <tr
              key={key}
              className={cx(
                onRowClick && 'is-click',
                selected && 'is-sel',
                faint?.(row) && 'is-faint',
              )}
              aria-current={selected ? 'true' : undefined}
              tabIndex={onRowClick ? 0 : undefined}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              onKeyDown={
                onRowClick
                  ? (e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        onRowClick(row);
                      }
                    }
                  : undefined
              }
            >
              {columns.map((c) => (
                <td
                  key={c.key}
                  className={cx(c.align === 'right' && 'is-right')}
                >
                  <div className="ui-tbl-cell">{c.cell(row)}</div>
                </td>
              ))}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
