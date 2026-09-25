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

  it('shows hover actions on hover and hides them again', () => {
    const { item } = renderRow();
    expect(
      screen.queryByRole('button', { name: 'Open' }),
    ).not.toBeInTheDocument();
    fireEvent.mouseEnter(item);
    expect(screen.getByRole('button', { name: 'Open' })).toBeInTheDocument();
    expect(screen.queryByText('09:15')).not.toBeInTheDocument();
    fireEvent.mouseLeave(item);
    expect(
      screen.queryByRole('button', { name: 'Open' }),
    ).not.toBeInTheDocument();
  });

  it('shows hover actions while the row holds keyboard focus', () => {
    renderRow();
    const main = screen.getByRole('button', { name: /Quarterly report/ });
    fireEvent.focus(main);
    const open = screen.getByRole('button', { name: 'Open' });
    // Moving focus onto the action keeps the row active.
    fireEvent.blur(main, { relatedTarget: open });
    expect(screen.getByRole('button', { name: 'Open' })).toBeInTheDocument();
    fireEvent.blur(open, { relatedTarget: document.body });
    expect(
      screen.queryByRole('button', { name: 'Open' }),
    ).not.toBeInTheDocument();
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
        <Row title="Static" trail={<span>ok</span>} />
      </Rows>,
    );
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getByText('ok')).toBeInTheDocument();
  });
});
