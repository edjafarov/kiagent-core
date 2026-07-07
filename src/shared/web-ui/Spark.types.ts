export type SparkState = 'idle' | 'mcp' | 'error' | 'paused' | 'blink';
export type SparkSize = 'inline' | 'tray' | 'app' | 'hero';

export interface SparkProps {
  state?: SparkState;
  size?: SparkSize;
  dark?: boolean;
  /** Bump on each new MCP call to re-trigger the pop animation. */
  pulseSeq?: number;
  className?: string;
}
