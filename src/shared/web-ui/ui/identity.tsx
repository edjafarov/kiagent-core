import React from 'react';
import { Icon } from '../icon-sprite';
import type { Brand } from './brands';
import { cx } from './cx';

function brandStyle(brand: Brand): React.CSSProperties | undefined {
  return brand.color
    ? ({ '--brand': brand.color } as React.CSSProperties)
    : undefined;
}

const ICON_SIZE = { 20: 12, 24: 14, 32: 18 } as const;

/** A square in the toned brand colour with a white icon or initials. */
export function BrandGlyph(props: {
  brand: Brand;
  size?: 20 | 24 | 32;
  faint?: boolean;
  /** Names the glyph when no text next to it does. */
  label?: string;
}): React.ReactElement {
  const { brand, size = 24, faint, label } = props;
  const a11y = label
    ? { role: 'img', 'aria-label': label }
    : { 'aria-hidden': true as const };
  const cls = cx(
    'ui-glyph',
    size !== 24 && `is-${size}`,
    faint && 'is-faint',
    brand.imageUrl && !brand.color
      ? 'is-img'
      : brand.color == null && 'is-neutral',
  );
  if (brand.imageUrl && !brand.color) {
    return (
      <span className={cls} {...a11y}>
        <img src={brand.imageUrl} alt="" />
      </span>
    );
  }
  return (
    <span className={cls} style={brandStyle(brand)} {...a11y}>
      {brand.icon ? (
        <Icon name={brand.icon} size={ICON_SIZE[size]} />
      ) : (
        <span className="ui-glyph-ini">{brand.initials}</span>
      )}
    </span>
  );
}

/** A 3px stripe in the toned brand colour; its height follows the row. */
export function BrandMark(props: {
  brand: Brand;
  faint?: boolean;
}): React.ReactElement {
  return (
    <span
      className={cx('ui-mk', props.faint && 'is-faint')}
      style={brandStyle(props.brand)}
      aria-hidden="true"
    />
  );
}

export function DateTile(props: {
  date: Date;
  today?: boolean;
}): React.ReactElement {
  return (
    <span className={cx('ui-dt', props.today && 'is-today')}>
      <span className="ui-dt-d">{props.date.getDate()}</span>
      <span className="ui-dt-m">
        {props.date.toLocaleString('en-GB', { month: 'short' })}
      </span>
    </span>
  );
}

export function Avatar(props: {
  name: string;
  imageUrl?: string | null;
}): React.ReactElement {
  const initial = (props.name.trim()[0] ?? '?').toUpperCase();
  return (
    <span className="ui-avatar" aria-hidden="true">
      {props.imageUrl ? <img src={props.imageUrl} alt="" /> : initial}
    </span>
  );
}

export function Chip(props: {
  brand: Brand;
  name: string;
  count?: number;
  onClick?: () => void;
}): React.ReactElement {
  return (
    <button type="button" className="ui-chip" onClick={props.onClick}>
      <BrandMark brand={props.brand} />
      <span>{props.name}</span>
      {props.count != null && <span className="ui-chip-n">{props.count}</span>}
    </button>
  );
}
