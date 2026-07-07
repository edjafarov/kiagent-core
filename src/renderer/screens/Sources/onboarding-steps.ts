import type { AppState, OnboardingPrefs } from '@shared/contracts';

export interface OnboardingDerived {
  step1Done: boolean;
  step2Done: boolean;
  step3Done: boolean;
  visible: boolean;
}

/** Pure mapping from the persisted latches to the checklist display state.
 *  Visible until every step latches or the user skips — the panel collapses
 *  on its own the moment the first successful MCP query lands. */
export function deriveOnboarding(
  onboarding: OnboardingPrefs,
): OnboardingDerived {
  const step1Done = onboarding.sourceBackfilledAt != null;
  const step2Done = onboarding.mcpConnectedAt != null;
  const step3Done = onboarding.firstQueryAt != null;
  return {
    step1Done,
    step2Done,
    step3Done,
    visible:
      onboarding.dismissedAt == null && !(step1Done && step2Done && step3Done),
  };
}

/** Meta line under "Add a source" — live status, deliberately no %/ETA
 *  (greenfield has no backfill total estimate; spec non-goal). */
export function step1Meta(
  accounts: AppState['accounts'],
  done: boolean,
): string {
  if (done) {
    const n = accounts.length;
    return n > 0
      ? `${n} source${n === 1 ? '' : 's'} connected`
      : 'Source connected';
  }
  const status = accounts[0]?.account.status;
  if (status == null)
    return 'Connect your first source to start building your memory.';
  if (status === 'backfilling') return 'Backfilling — syncing your history…';
  return 'Setting up your first source…';
}
