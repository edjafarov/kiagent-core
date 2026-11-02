import type { SyncStatus } from '@shared/contracts';

/** An account that never starts by itself: the cadence tick, boot's resume,
 *  a folder-scope restart and a config save all leave it alone, and only the
 *  user's explicit Retry or Resume (or, for needs-connector, installing the
 *  connector) moves it on. ONE predicate, so a new resting status can't be
 *  forgotten by one of those paths (resting-states.test.ts holds the line). */
export const isResting = (status: SyncStatus): boolean =>
  status === 'paused' || status === 'needsReauth' || status === 'needs-connector';

/** Resting, and not even an explicit Retry starts it: the user paused it, or
 *  its connector isn't installed. A needsReauth account is the one resting
 *  state a Retry may start (reconnecting fixes it). */
export const isParked = (status: SyncStatus): boolean =>
  status === 'paused' || status === 'needs-connector';
