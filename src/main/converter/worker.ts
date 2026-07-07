/**
 * Entry point reserved for the crash-isolated converter pool. Conversion
 * currently runs in-process (core/engine/convert.ts); moving the parsers
 * into this worker restores crash isolation and backpressure for large
 * binary backfills. Tracked in docs/rebuild/LEFTOVERS.md.
 */
export {};
