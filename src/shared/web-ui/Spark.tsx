import React from 'react';
import type { SparkProps, SparkState } from './Spark.types';
import {
  BRACKET_PATHS,
  BRACKET_SPARK_TRANSFORM,
  SPARK_PATH,
  SPARK_VIEWBOX,
} from './spark-geometry';

export type { SparkProps, SparkSize, SparkState } from './Spark.types';

const SHOW_BADGE: Record<SparkState, boolean> = {
  idle: false,
  blink: false,
  paused: false,
  mcp: true,
  error: true,
};

export function Spark(props: SparkProps): React.ReactElement {
  const state = props.state ?? 'idle';
  const size = props.size ?? 'inline';
  const pulseSeq = props.pulseSeq ?? 0;

  // Degradation rule (brand spec, Bracket §05): the reticle only reads at
  // ≥ 24px, so it shows for app/hero and drops away for inline/tray, where the
  // bare Spark carries the mark.
  const framed = size === 'app' || size === 'hero';

  const cls = [
    'kg-spark',
    `size-${size}`,
    `state-${state}`,
    props.dark ? 'is-dark' : null,
    props.className ?? null,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <span className={cls} aria-hidden="true">
      <svg
        className="kg-spark__star"
        viewBox={SPARK_VIEWBOX}
        fill="currentColor"
        aria-hidden="true"
      >
        {framed &&
          BRACKET_PATHS.map((d, i) => (
            <path key={i} className="kg-spark__frame" d={d} />
          ))}
        {framed ? (
          <g transform={BRACKET_SPARK_TRANSFORM}>
            <path d={SPARK_PATH} />
          </g>
        ) : (
          <path d={SPARK_PATH} />
        )}
      </svg>
      {SHOW_BADGE[state] && (
        <span
          key={pulseSeq}
          className="kg-spark__badge"
          data-pulse-seq={String(pulseSeq)}
        />
      )}
    </span>
  );
}
