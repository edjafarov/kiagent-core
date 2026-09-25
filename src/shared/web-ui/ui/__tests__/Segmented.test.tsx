import '@testing-library/jest-dom';
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { Segmented, type SegmentedItem } from '..';

type K = 'all' | 'needs' | 'done';
const items: SegmentedItem<K>[] = [
  { key: 'all', label: 'All', count: 12 },
  { key: 'needs', label: 'Needs you', count: 3, countTone: 'work' },
  { key: 'done', label: 'Done' },
];

function Harness(props: { onChange?: (k: K) => void }) {
  const [value, setValue] = React.useState<K>('all');
  return (
    <Segmented
      aria-label="Filter"
      items={items}
      value={value}
      onChange={(k) => {
        setValue(k);
        props.onChange?.(k);
      }}
    />
  );
}

describe('Segmented', () => {
  it('is a named tablist with one selected, focusable tab', () => {
    render(<Harness />);
    expect(screen.getByRole('tablist', { name: 'Filter' })).toBeInTheDocument();
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((t) => t.getAttribute('aria-selected'))).toEqual([
      'true',
      'false',
      'false',
    ]);
    expect(tabs.map((t) => t.tabIndex)).toEqual([0, -1, -1]);
    expect(tabs[1]).toHaveTextContent('Needs you3');
  });

  it('selects by click', () => {
    const onChange = jest.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.click(screen.getByRole('tab', { name: /Done/ }));
    expect(onChange).toHaveBeenCalledWith('done');
    expect(screen.getByRole('tab', { name: /Done/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  it('moves with arrows (wrapping), Home and End', () => {
    render(<Harness />);
    const [all, , done] = screen.getAllByRole('tab');
    all.focus();
    fireEvent.keyDown(all, { key: 'ArrowLeft' });
    expect(done).toHaveFocus();
    expect(done).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(done, { key: 'ArrowRight' });
    expect(all).toHaveFocus();
    fireEvent.keyDown(all, { key: 'End' });
    expect(done).toHaveFocus();
    fireEvent.keyDown(done, { key: 'Home' });
    expect(all).toHaveFocus();
  });
});
