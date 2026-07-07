import type { SparkState, SparkSize } from './Spark.types';
import { sparkSvgMarkup } from './spark-geometry';

export interface SparkHtmlOpts {
  state?: SparkState;
  size?: SparkSize;
  dark?: boolean;
  pulseSeq?: number;
}

const SHOW_BADGE: Record<SparkState, boolean> = {
  idle: false,
  blink: false,
  paused: false,
  mcp: true,
  error: true,
};

export function sparkHtml(opts: SparkHtmlOpts = {}): string {
  const state = opts.state ?? 'idle';
  const size = opts.size ?? 'inline';
  const pulseSeq = opts.pulseSeq ?? 0;
  const classes = ['kg-spark', `size-${size}`, `state-${state}`];
  if (opts.dark) classes.push('is-dark');
  const badge = SHOW_BADGE[state]
    ? `<span class="kg-spark__badge" data-pulse-seq="${pulseSeq}"></span>`
    : '';
  // Frame the mark in the reticle at ≥24px (app / hero); bare Spark below
  // (brand spec, Bracket §05 degradation rule) — matches Spark.tsx.
  const framed = size === 'app' || size === 'hero';
  const star = sparkSvgMarkup({ className: 'kg-spark__star', frame: framed });
  return (
    `<span class="${classes.join(' ')}" aria-hidden="true">` +
    `${star}${badge}</span>`
  );
}
