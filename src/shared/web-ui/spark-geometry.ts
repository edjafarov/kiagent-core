/*
 * KIAgent brand mark — canonical vector geometry.
 *
 * The Spark: a concave four-pointed star drawn to a single curve law —
 * four needle points on the axes (radius 47u) and concave Bézier shoulders
 * pulled to a tight central waist (0.40R ≈ 18.6u). Sharp corners, 0 radius.
 *
 * The Bracket: the Spark held inside a focus reticle — four L-shaped corner
 * ticks (inset 9u, arm 16u, stroke 5u) in a lighter "Violet Light" tone. The
 * reticle is the ownable layer that stops the mark reading as a generic
 * floating AI sparkle; it appears only at sizes ≥ 24px (app / hero). Below
 * that the Spark carries the mark alone (16–22px), then a solid tile (≤16px).
 *
 * This is the one source of truth for the mark's shape. The React component
 * (Spark.tsx), the server-rendered string (spark-html.ts), and the raster
 * asset pipeline (assets/brand/*.svg) all derive from the geometry below — so
 * the mark is identical from a 1024px dock icon down to a 16px menubar tray.
 *
 * Reference: "KIAgent Logo — Brand Spec (Bracket)", §02–03 (anatomy +
 * construction). The mark never rotates, never gradients, never softens; the
 * reticle never closes into a box and its arms never thicken.
 */

/** viewBox the canonical path is drawn in. */
export const SPARK_VIEWBOX = '0 0 100 100';

/** The Spark — canonical SVG path data (viewBox 0 0 100 100). */
export const SPARK_PATH =
  'M50 3 C 52.5 33 67 47.5 97 50 C 67 52.5 52.5 67 50 97 ' +
  'C 47.5 67 33 52.5 3 50 C 33 47.5 47.5 33 50 3 Z';

/**
 * The Bracket reticle — four L-shaped corner ticks framing the Spark, one per
 * corner, inset 9u from the edge with 16u arms (brand spec, Bracket §03).
 * Drawn `fill:none` and stroked; never extended toward a closed box.
 */
export const BRACKET_PATHS = [
  'M9 25 L9 9 L25 9',
  'M91 25 L91 9 L75 9',
  'M9 75 L9 91 L25 91',
  'M91 75 L91 91 L75 91',
] as const;

/** Reticle stroke weight, in viewBox units (butt caps, miter joins). */
export const BRACKET_STROKE_WIDTH = 5;

/** The reticle frame tone — "Violet Light" (brand spec §06). */
export const BRACKET_FRAME_COLOR = '#a78bfa';

/**
 * Transform that places the canonical Spark, centred at (50,50) and scaled to
 * radius 28u, inside the reticle. The bare path spans radius 47u (fills the
 * box); framed, the Spark sits smaller so the reticle can breathe around it.
 * s = 28/47 ≈ 0.595745; offset = 50 − 50·s ≈ 20.2128.
 */
export const BRACKET_SPARK_TRANSFORM =
  'translate(20.2128 20.2128) scale(0.595745)';

export interface SparkSvgOpts {
  /** Fill color. Defaults to `currentColor` so it inherits the CSS cascade. */
  fill?: string;
  /** Optional class applied to the <svg> element. */
  className?: string;
  /** Optional title for assistive tech; omitted (aria-hidden) when absent. */
  title?: string;
  /**
   * Wrap the Spark in the Bracket reticle (brand spec). Use for marks rendered
   * at ≥ 24px (app / hero); leave off for inline / tray, where the reticle
   * can't survive and the bare Spark carries the mark. The frame stroke is
   * inlined so the markup stays self-contained without external CSS.
   */
  frame?: boolean;
}

/**
 * Inline `<svg>` markup string for the drawn mark. Used anywhere the mark is
 * rendered as an HTML string rather than React (e.g. the MCP consent shell).
 * Scales to its container via width/height:100% on the element. Pass
 * `frame: true` for the framed Bracket; omit it for the bare Spark.
 */
export function sparkSvgMarkup(opts: SparkSvgOpts = {}): string {
  const fill = opts.fill ?? 'currentColor';
  const cls = opts.className ? ` class="${opts.className}"` : '';
  const a11y = opts.title
    ? `role="img" aria-label="${opts.title}"`
    : 'aria-hidden="true"';
  const sparkPath = `<path d="${SPARK_PATH}" fill="${fill}"/>`;
  const ticks = BRACKET_PATHS.map(
    (d) =>
      `<path d="${d}" fill="none" stroke="${BRACKET_FRAME_COLOR}" stroke-width="${BRACKET_STROKE_WIDTH}"/>`,
  ).join('');
  const inner = opts.frame
    ? `${ticks}<g transform="${BRACKET_SPARK_TRANSFORM}">${sparkPath}</g>`
    : sparkPath;
  return (
    `<svg${cls} viewBox="${SPARK_VIEWBOX}" ${a11y} ` +
    `xmlns="http://www.w3.org/2000/svg">${inner}</svg>`
  );
}
