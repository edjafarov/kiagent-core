import React, { useRef } from 'react';
import { cx } from './cx';

export interface SegmentedItem<K extends string> {
  key: K;
  label: React.ReactNode;
  count?: number;
  /** An amber count (things waiting on the user). */
  countTone?: 'work';
}

/** Square tabs in a bordered strip; the active tab is filled deep violet. */
export function Segmented<K extends string>(props: {
  items: readonly SegmentedItem<K>[];
  value: K;
  onChange: (key: K) => void;
  'aria-label': string;
}): React.ReactElement {
  const { items, value, onChange } = props;
  const refs = useRef<Array<HTMLButtonElement | null>>([]);

  const move = (to: number): void => {
    const n = items.length;
    const index = ((to % n) + n) % n;
    refs.current[index]?.focus();
    onChange(items[index].key);
  };

  const onKeyDown = (e: React.KeyboardEvent, index: number): void => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') move(index + 1);
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') move(index - 1);
    else if (e.key === 'Home') move(0);
    else if (e.key === 'End') move(items.length - 1);
    else return;
    e.preventDefault();
  };

  return (
    <div className="ui-seg" role="tablist" aria-label={props['aria-label']}>
      {items.map((item, i) => {
        const active = item.key === value;
        return (
          <button
            key={item.key}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="tab"
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            className={cx('ui-seg-i', active && 'is-on')}
            onClick={() => onChange(item.key)}
            onKeyDown={(e) => onKeyDown(e, i)}
          >
            {item.label}
            {item.count != null && (
              <b
                className={cx(
                  'ui-seg-n',
                  item.countTone === 'work' && 'is-work',
                )}
              >
                {item.count}
              </b>
            )}
          </button>
        );
      })}
    </div>
  );
}
