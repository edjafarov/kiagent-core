import '@testing-library/jest-dom';
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { Rows, Row, DayGroup } from '..';

function renderRow(extra: Partial<React.ComponentProps<typeof Row>> = {}) {
  const onOpen = jest.fn();
  render(
    <Rows aria-label="Today">
      <DayGroup>Today</DayGroup>
      <Row
        title="Quarterly report"
        sub="Gmail · Alex Morgan"
        time="09:15"
        onClick={onOpen}
        hoverActions={<button type="button">Open</button>}
        {...extra}
      />
    </Rows>,
  );
  return { onOpen, item: screen.getByText('Quarterly report').closest('li')! };
}

describe('Row', () => {
  it('renders title, second line, time and the day label', () => {
    renderRow();
    expect(screen.getByRole('list', { name: 'Today' })).toBeInTheDocument();
    expect(screen.getByText('Gmail · Alex Morgan')).toBeInTheDocument();
    expect(screen.getByText('09:15')).toBeInTheDocument();
    expect(screen.getAllByText('Today')).toHaveLength(1);
  });

  it('activates through its main button', () => {
    const { onOpen } = renderRow();
    fireEvent.click(screen.getByRole('button', { name: /Quarterly report/ }));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('keeps hover actions mounted and in tab order beside the time', () => {
    const { item } = renderRow();
    const open = screen.getByRole('button', { name: 'Open' });
    expect(item.contains(open)).toBe(true);
    expect(open.tabIndex).toBe(0);
    expect(screen.getByText('09:15')).toBeInTheDocument();
  });

  it('reaches hover actions by keyboard on a row without a main action', () => {
    render(
      <Rows>
        <Row
          title="Static"
          hoverActions={<button type="button">Retry</button>}
        />
      </Rows>,
    );
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual([
      'Retry',
    ]);
  });

  it('marks the selected row as current', () => {
    renderRow({ selected: true });
    expect(
      screen.getByRole('button', { name: /Quarterly report/ }),
    ).toHaveAttribute('aria-current', 'true');
  });

  it('renders a plain row without a button when it has no action', () => {
    render(
      <Rows>
        <Row title="Static" trail={<span>ok</span>} data-testid="static-row" />
      </Rows>,
    );
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getByText('ok')).toBeInTheDocument();
    expect(screen.getByTestId('static-row')).toBe(screen.getByRole('listitem'));
  });

  it('shows a detail below the line and lets the row grow for it', () => {
    const { item } = renderRow();
    expect(item).not.toHaveClass('has-detail');
    renderRow({ title: 'Invoice', detail: 'Moved because it is an invoice.' });
    const other = screen.getByText('Invoice').closest('li')!;
    expect(other).toHaveClass('has-detail');
    expect(screen.getByText('Moved because it is an invoice.')).toHaveClass(
      'ui-row-detail',
    );
  });
});
