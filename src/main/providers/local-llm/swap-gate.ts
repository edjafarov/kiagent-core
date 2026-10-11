/**
 * Which model the ONE llama-server may run, and the embed hold (spec
 * 2026-10-11 messages classification §4.B, plan-time simplification).
 *
 * The chat model and the embedding model never have requests in flight
 * together, so a model swap (provider.ts ensureServer) never kills work.
 * Once `embed` starts it HOLDS the server: background chat is refused with
 * LaneClosedError until the hold ends —
 *   - 2 min without an embed call (the queue drained), or
 *   - a flat 60 min cap, after which embed is refused for 10 min so
 *     background chat gets a turn.
 * An interactive chat call (a person waiting) ends the hold: it waits for
 * the in-flight embed batch, cancels embed calls still waiting, and embed is
 * refused until 2 min after the last interactive call, so a conversation
 * does not reload the chat model on every turn.
 *
 * No timers: every rule is evaluated when a call enters or leaves.
 */
import { LaneClosedError, type Lane } from '@shared/contracts';

export type ServerModel = 'chat' | 'embed';

export const HOLD_IDLE_MS = 2 * 60_000;
export const HOLD_CAP_MS = 60 * 60_000;
export const CAP_COOLDOWN_MS = 10 * 60_000;
export const INTERACTIVE_QUIET_MS = 2 * 60_000;

export interface SwapGate {
  /** Resolves to an idempotent release once `model` may run; rejects
   *  LaneClosedError when refused. */
  enter(model: ServerModel, lane: Lane): Promise<() => void>;
  held(): boolean;
}

interface Waiter {
  model: ServerModel;
  interactive: boolean;
  admit(): void;
  refuse(why: string): void;
}

export function createSwapGate(opts?: { now?: () => number }): SwapGate {
  const now = opts?.now ?? Date.now;
  const inflight = { chat: 0, embed: 0 };
  let interactiveInflight = 0;
  let held = false;
  let heldSince = 0;
  let lastEmbed = 0;
  let cooldownUntil = -Infinity;
  let lastInteractive = -Infinity;
  const waiters: Waiter[] = [];

  /** Ends the hold at whichever deadline came FIRST: idle (no embed in
   *  flight or waiting, 2 min since the last) or the 60-min cap (which
   *  starts the cooldown, counted from the cap). Evaluated lazily, so a hold
   *  that went idle hours ago is an idle release, not a cap release. */
  const expire = (): void => {
    if (!held) return;
    const t = now();
    const capAt = heldSince + HOLD_CAP_MS;
    const idle =
      inflight.embed === 0 && !waiters.some((w) => w.model === 'embed');
    const idleAt = idle ? lastEmbed + HOLD_IDLE_MS : Infinity;
    if (idleAt <= capAt && t >= idleAt) {
      held = false;
    } else if (t >= capAt) {
      held = false;
      cooldownUntil = capAt + CAP_COOLDOWN_MS;
    }
  };

  const release = (model: ServerModel, interactive: boolean) => {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      inflight[model] -= 1;
      if (interactive) interactiveInflight -= 1;
      if (model === 'embed') lastEmbed = now();
      pump();
    };
  };

  /** Admit waiters whose model may run now, in arrival order. */
  const pump = (): void => {
    expire();
    // admit/refuse only settle promises (no synchronous re-entry), so the
    // queue can be rebuilt in one pass.
    for (const w of waiters.splice(0)) {
      if (w.model === 'embed') {
        if (!held) w.refuse('the embed hold ended');
        else if (inflight.chat === 0) w.admit();
        else waiters.push(w);
      } else if (!w.interactive && held) {
        w.refuse('local model is held for embeddings');
      } else if (inflight.embed === 0) w.admit();
      else waiters.push(w);
    }
  };

  const wait = (model: ServerModel, interactive: boolean) =>
    new Promise<() => void>((resolve, reject) => {
      const admit = () => {
        inflight[model] += 1;
        if (interactive) interactiveInflight += 1;
        if (model === 'embed') lastEmbed = now();
        resolve(release(model, interactive));
      };
      const ready =
        model === 'embed' ? inflight.chat === 0 : inflight.embed === 0;
      if (ready) admit();
      else
        waiters.push({
          model,
          interactive,
          admit,
          refuse: (why) => reject(new LaneClosedError(why)),
        });
    });

  return {
    enter(model, lane) {
      expire();
      const t = now();
      if (model === 'embed') {
        if (t < cooldownUntil)
          return Promise.reject(new LaneClosedError('embed hold cooling down'));
        if (
          t - lastInteractive < INTERACTIVE_QUIET_MS ||
          interactiveInflight > 0 ||
          waiters.some((w) => w.interactive)
        )
          return Promise.reject(
            new LaneClosedError('local model is answering a person'),
          );
        if (!held) {
          held = true;
          heldSince = t;
          lastEmbed = t;
        }
        return wait('embed', false);
      }
      if (lane === 'interactive') {
        lastInteractive = t;
        if (held) {
          held = false;
          pump(); // refuses the embed calls still waiting
        }
        return wait('chat', true);
      }
      if (held)
        return Promise.reject(
          new LaneClosedError('local model is held for embeddings'),
        );
      return wait('chat', false);
    },
    held() {
      expire();
      return held;
    },
  };
}
