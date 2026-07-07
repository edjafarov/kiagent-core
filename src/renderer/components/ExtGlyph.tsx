import React from 'react';
import './ExtGlyph.css';

/**
 * Extension identity glyph — the ONE way an extension's icon renders
 * (marketplace list rows, detail head, consent modal). Shows the manifest
 * PNG (delivered as a data URI) when present, else an accent-tinted tile
 * with the name's initial. Purely decorative: the name is always rendered
 * as text beside it, so both variants are aria-hidden.
 */
export function ExtGlyph(props: {
  name: string;
  iconDataUrl?: string;
  size: number;
  /** Wrap the brand icon in a white bordered tile — for muted-background
   *  surfaces (marketplace list/detail head) where a bare mark floats. The
   *  letter fallback is already a tile and ignores this. */
  boxed?: boolean;
}): React.ReactElement {
  const { name, iconDataUrl, size, boxed } = props;
  if (iconDataUrl) {
    const imgSize = boxed ? Math.round(size * 0.68) : size;
    const img = (
      <img
        className="ext-glyph-img"
        src={iconDataUrl}
        alt=""
        aria-hidden="true"
        style={{ width: imgSize, height: imgSize }}
      />
    );
    if (boxed) {
      return (
        <span
          className="ext-glyph-box"
          aria-hidden="true"
          style={{ width: size, height: size }}
        >
          {img}
        </span>
      );
    }
    return img;
  }
  return (
    <span
      className="ext-glyph-fallback"
      aria-hidden="true"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.47) }}
    >
      {(name.trim()[0] ?? '?').toUpperCase()}
    </span>
  );
}
