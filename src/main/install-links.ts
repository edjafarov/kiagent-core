/**
 * `kiagent://install?repo=owner/repo[&tag=…]` links (spec §8). The OS hands
 * a clicked link to the app (macOS `open-url`; Windows/Linux argv, at start
 * or on a second launch). This keeps ONE pending link — the latest click
 * wins — and the renderer takes it when it is ready. A link never installs
 * anything: the renderer only prefills the Add from GitHub sheet.
 *
 * Product-gated: without a scheme (the OSS build) nothing is handled.
 */
import { parseInstallLink, type RepoRef } from '@shared/install-link';

export type PendingLink = { seq: number } & RepoRef;

export function createInstallLinks(deps: {
  scheme: string | undefined;
  /** Bring the window forward (creating it only once startup made one). */
  show(): void;
  /** Tell renderers a link is waiting (`push:install-link`). */
  nudge(): void;
  log(msg: string): void;
}) {
  let pending: PendingLink | null = null;
  let seq = 0;
  let ready = false;

  function offer(candidate: string): void {
    if (!deps.scheme) return;
    const r = parseInstallLink(candidate, deps.scheme);
    if (!r) {
      // Never the URL itself: a link's text is not ours to log.
      deps.log('ignored install link');
      return;
    }
    seq += 1;
    pending = { seq, ...r };
    // Before startup made the window, startup shows it; the renderer takes
    // the link when it mounts.
    if (ready) {
      deps.show();
      deps.nudge();
    }
  }

  return {
    offer,
    /** Windows/Linux: the link arrives as a command-line argument. */
    offerArgv(argv: readonly string[]): void {
      if (!deps.scheme) return;
      const prefix = `${deps.scheme.toLowerCase()}:`;
      const arg = argv.find((a) => a.toLowerCase().startsWith(prefix));
      if (arg) offer(arg);
    },
    /** The renderer's take: the pending link, once. */
    take(): PendingLink | null {
      const p = pending;
      pending = null;
      return p;
    },
    /** Startup has made the window. */
    markReady(): void {
      ready = true;
      if (pending) {
        deps.show();
        deps.nudge();
      }
    },
  };
}
