import '@testing-library/jest-dom';
import React from 'react';
import { render, screen } from '@testing-library/react';
import { AttentionList, AttentionRow, KpiGrid, Kpi } from '..';

describe('AttentionList', () => {
  it('renders one list item per row with its kind word, title, sub and action', () => {
    render(
      <AttentionList aria-label="Needs you">
        <AttentionRow
          tone="acc"
          kind="Review"
          title={
            <>
              <b>Claude</b> drafted a reply
            </>
          }
          sub="to Alex Morgan"
          action={<button type="button">Review</button>}
        />
        <AttentionRow tone="err" kind="Error" title="Gmail signed out" />
      </AttentionList>,
    );
    const list = screen.getByRole('list', { name: 'Needs you' });
    expect(list.querySelectorAll('li')).toHaveLength(2);
    expect(screen.getByText('to Alex Morgan')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Review' })).toBeInTheDocument();
    expect(screen.getByText('Error')).toBeInTheDocument();
  });

  it('marks the tone on the row', () => {
    render(
      <AttentionList>
        <AttentionRow
          tone="work"
          kind="Sort"
          title="3 files"
          data-testid="sort-row"
        />
      </AttentionList>,
    );
    expect(screen.getByRole('listitem')).toHaveClass('is-work');
    expect(screen.getByTestId('sort-row')).toBe(screen.getByRole('listitem'));
  });

  it('shows a detail below the line and lets the row grow for it', () => {
    const { rerender } = render(
      <AttentionList>
        <AttentionRow tone="work" kind="Sort" title="report.pdf" />
      </AttentionList>,
    );
    expect(screen.getByRole('listitem')).not.toHaveClass('has-detail');
    rerender(
      <AttentionList>
        <AttentionRow
          tone="work"
          kind="Sort"
          title="report.pdf"
          detail="The text could not be read."
        />
      </AttentionList>,
    );
    expect(screen.getByRole('listitem')).toHaveClass('has-detail');
    expect(screen.getByText('The text could not be read.')).toHaveClass(
      'ui-att-detail',
    );
  });
});

describe('Kpi', () => {
  it('renders value, the "of" total and the label', () => {
    render(
      <KpiGrid>
        <Kpi value={12} of={13} label="sources syncing" />
        <Kpi value="1,284" label="documents today" wide />
      </KpiGrid>,
    );
    expect(screen.getByText('sources syncing')).toBeInTheDocument();
    expect(screen.getByText('/ 13')).toBeInTheDocument();
    expect(screen.getByText('1,284')).toBeInTheDocument();
  });

  it('runs in one row when asked', () => {
    const { container } = render(
      <KpiGrid layout="row">
        <Kpi value={3} label="meetings today" />
      </KpiGrid>,
    );
    expect(container.firstElementChild).toHaveClass('ui-kpis', 'is-row');
  });
});
