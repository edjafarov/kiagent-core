// Moved to @shared so the boot-time finish of an interrupted reset (main)
// words its outcome the same way. This path stays because product overlays
// import it (alpha-cent's Storage shadow).
export { describeResetOutcome } from '@shared/reset-outcome';
