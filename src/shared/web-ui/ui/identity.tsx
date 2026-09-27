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
        {/* Three letters, as drawn: en-GB's short September is "Sept". */}
        {props.date.toLocaleString('en-GB', { month: 'short' }).slice(0, 3)}
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
  /** Omitted: a plain word chip with no mark. */
  brand?: Brand;
  name: string;
  count?: number;
  /** A verb shown after the name in the accent colour, e.g. "Add". */
  action?: string;
  onClick?: () => void;
  /** Renders the chip as a label with a trailing × that removes it. */
  onRemove?: () => void;
}): React.ReactElement {
  const body = (
    <>
      {props.brand && <BrandMark brand={props.brand} />}
      <span>{props.name}</span>
      {props.count != null && <span className="ui-chip-n">{props.count}</span>}
      {props.action && <span className="ui-chip-act">{props.action}</span>}
    </>
  );
  if (props.onRemove) {
    return (
      <span className="ui-chip is-static">
        {body}
        <button
          type="button"
          className="ui-chip-x"
          aria-label={`Remove ${props.name}`}
          onClick={props.onRemove}
        >
          ×
        </button>
      </span>
    );
  }
  return (
    <button
      type="button"
      className="ui-chip"
      aria-label={props.action ? `${props.action} ${props.name}` : undefined}
      onClick={props.onClick}
    >
      {body}
    </button>
  );
}

/** An entity's glyph, name and one meta line, with its actions after them:
 *  the head of a panel or a page. A string title becomes the heading; a
 *  node (e.g. an inline editor) is placed as given. */
export function EntityHeading(props: {
  brand: Brand;
  title: React.ReactNode;
  meta?: React.ReactNode;
  size?: 'panel' | 'page';
  children?: React.ReactNode;
}): React.ReactElement {
  const { brand, title, meta, size = 'panel', children } = props;
  return (
    <header className={cx('ui-ent', size === 'page' && 'is-page')}>
      <BrandGlyph brand={brand} size={32} />
      <div className="ui-ent-name">
        {typeof title === 'string' ? (
          <h2 className="ui-ent-t">{title}</h2>
        ) : (
          title
        )}
        {meta != null && <span className="ui-ent-m">{meta}</span>}
      </div>
      {children}
    </header>
  );
}
