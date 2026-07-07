import React from 'react';
import {
  BRACKET_FRAME_COLOR,
  BRACKET_PATHS,
  BRACKET_SPARK_TRANSFORM,
  BRACKET_STROKE_WIDTH,
  SPARK_PATH,
  SPARK_VIEWBOX,
} from './spark-geometry';

/* React wrappers around the design-system CSS classes. They're thin
   on purpose — the CSS is the source of truth, these just enforce
   correct class composition and the brand's content discipline
   (e.g. the wordmark always has the drawn Spark before the name). */

// ── SparkGlyph ──────────────────────────────────────────────────

/* The drawn Spark mark, sized to the current font's em-box and inheriting
   `color` as its fill. A drop-in for inline accent contexts (wordmark,
   onboarding headers) where the mark sits on a baseline next to text. */
export function SparkGlyph(props: { className?: string }): React.ReactElement {
  return (
    <svg
      className={props.className}
      viewBox={SPARK_VIEWBOX}
      width="1em"
      height="1em"
      fill="currentColor"
      aria-hidden="true"
      style={{ verticalAlign: '-0.125em', flexShrink: 0 }}
    >
      <path d={SPARK_PATH} />
    </svg>
  );
}

// ── BracketMark ─────────────────────────────────────────────────

/* The framed Bracket — the Spark held inside the focus reticle — at a fixed
   pixel size. This is the brand's primary logo mark for lockups (brand spec,
   Bracket §08: "the framed mark leads"). Unlike SparkGlyph (a 1em inline
   accent that renders the bare Spark), this renders the reticle, so it must be
   sized ≥ 24px for the ticks to read. The frame stroke is inlined so it needs
   no external CSS; the Spark inherits `currentColor`. */
export function BracketMark(props: {
  size?: number;
  className?: string;
}): React.ReactElement {
  const size = props.size ?? 24;
  return (
    <svg
      className={props.className}
      width={size}
      height={size}
      viewBox={SPARK_VIEWBOX}
      fill="currentColor"
      aria-hidden="true"
      style={{ flexShrink: 0 }}
    >
      {BRACKET_PATHS.map((d, i) => (
        <path
          key={i}
          d={d}
          fill="none"
          stroke={BRACKET_FRAME_COLOR}
          strokeWidth={BRACKET_STROKE_WIDTH}
        />
      ))}
      <g transform={BRACKET_SPARK_TRANSFORM}>
        <path d={SPARK_PATH} />
      </g>
    </svg>
  );
}

// ── Wordmark ────────────────────────────────────────────────────

export function Wordmark(props: {
  name?: string;
  className?: string;
}): React.ReactElement {
  return (
    <span className={`wordmark${props.className ? ` ${props.className}` : ''}`}>
      <BracketMark className="mark" />
      {props.name ?? 'KIAgent'}
    </span>
  );
}

// ── Pill ────────────────────────────────────────────────────────

export type PillVariant = 'live' | 'working' | 'error' | 'paused' | 'info';

export function Pill(props: {
  variant: PillVariant;
  children: React.ReactNode;
  title?: string;
}): React.ReactElement {
  return (
    <span className={`pill ${props.variant}`} title={props.title}>
      <span className="dot" aria-hidden="true" />
      {props.children}
    </span>
  );
}

// ── ConnectorKind ───────────────────────────────────────────────

export type ConnectorKind =
  | 'gmail'
  | 'google-docs'
  | 'onedrive'
  | 'local'
  | 'notion'
  | 'slack'
  | 'browser'
  | 'whatsapp'
  | 'instagram';

// ── ProvRow (onboarding provider button) ────────────────────────

export type ProvRowVariant =
  | 'primary'
  | 'google-signin'
  | 'microsoft-signin'
  | 'local-folder';

export function ProvRow(props: {
  variant: ProvRowVariant;
  glyph: React.ReactNode;
  label: string;
  meta?: React.ReactNode;
  disabled?: boolean;
  onClick?: () => void;
}): React.ReactElement {
  return (
    <button
      type="button"
      className={`prov-row ${props.variant}${props.disabled ? ' soon' : ''}`}
      disabled={props.disabled}
      onClick={props.onClick}
    >
      {props.glyph}
      <span className="prov-label">{props.label}</span>
      {props.meta != null && <span className="prov-meta">{props.meta}</span>}
    </button>
  );
}

// ── Onboarding divider ──────────────────────────────────────────

export function OnbDivider(props: { label?: string }): React.ReactElement {
  return (
    <div className="onb-divider" role="separator" aria-orientation="horizontal">
      <span className="line" aria-hidden="true" />
      <span className="or">{props.label ?? 'or'}</span>
      <span className="line" aria-hidden="true" />
    </div>
  );
}

// ── Spinner / Busy ──────────────────────────────────────────────

/* Inline circular spinner, 1em square so it scales with surrounding text.
   Purely presentational — pair it with visible text (or use Busy). */
export function Spinner(props: { className?: string }): React.ReactElement {
  return (
    <span
      className={`spinner${props.className ? ` ${props.className}` : ''}`}
      aria-hidden="true"
    />
  );
}

/* Inline loading status: spinner + label. Renders nothing for the first
   `delayMs` (default 200ms) so fast local IPC round-trips never flash a
   spinner; pass delayMs={0} to show immediately. The delay is armed once
   per mount, so mount/unmount Busy per loading episode rather than hiding
   it with CSS. */
export function Busy(props: {
  label?: string;
  delayMs?: number;
  className?: string;
}): React.ReactElement | null {
  const delayMs = props.delayMs ?? 200;
  const [visible, setVisible] = React.useState(delayMs <= 0);
  React.useEffect(() => {
    if (visible) return undefined;
    const timer = setTimeout(() => setVisible(true), delayMs);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- arm the timer once, on mount
  }, []);
  if (!visible) return null;
  return (
    <span
      className={`busy${props.className ? ` ${props.className}` : ''}`}
      role="status"
    >
      <Spinner />
      {props.label ?? 'Loading…'}
    </span>
  );
}

// ── Section label (.kg-label / .lbl-section) ────────────────────

export function SectionLabel(props: {
  children: React.ReactNode;
  className?: string;
}): React.ReactElement {
  return (
    <div className={`kg-label${props.className ? ` ${props.className}` : ''}`}>
      {props.children}
    </div>
  );
}
