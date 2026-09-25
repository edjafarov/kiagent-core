import '@testing-library/jest-dom';
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { DataTable, type DataColumn } from '..';

interface Src {
  id: string;
  name: string;
  docs: number;
}
const rows: Src[] = [
  { id: 'gmail', name: 'Gmail', docs: 1284 },
  { id: 'slack', name: 'Slack', docs: 312 },
];
const columns: DataColumn<Src>[] = [
  { key: 'name', header: 'Source', cell: (r) => r.name },
  {
    key: 'docs',
    header: 'Documents',
    align: 'right',
    width: '120px',
    cell: (r) => r.docs,
  },
];

describe('DataTable', () => {
  it('renders a named table with column headers and one row per item', () => {
    render(
      <DataTable
        aria-label="Sources"
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
      />,
    );
    expect(screen.getByRole('table', { name: 'Sources' })).toBeInTheDocument();
    expect(
      screen.getAllByRole('columnheader').map((h) => h.textContent),
    ).toEqual(['Source', 'Documents']);
    expect(screen.getAllByRole('row')).toHaveLength(3);
  });

  it('activates a row by click and by Enter, and marks the selected row', () => {
    const onRowClick = jest.fn();
    render(
      <DataTable
        aria-label="Sources"
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        selectedKey="slack"
        onRowClick={onRowClick}
      />,
    );
    const [, gmail, slack] = screen.getAllByRole('row');
    fireEvent.click(gmail);
    expect(onRowClick).toHaveBeenLastCalledWith(rows[0]);
    fireEvent.keyDown(slack, { key: 'Enter' });
    expect(onRowClick).toHaveBeenLastCalledWith(rows[1]);
    expect(slack).toHaveAttribute('aria-current', 'true');
    expect(gmail).not.toHaveAttribute('aria-current');
  });
});
