import type { FactoryResetOutcome } from '@shared/ipc';

const list = (names: string[]): string =>
  names.length <= 1
    ? names.join('')
    : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;

/** The one message a finished "Reset all" shows (alpha-cent#192). It never
 *  claims a wipe that did not commit, and never claims anything came back. */
export function describeResetOutcome(
  outcome: FactoryResetOutcome,
  nameOf: (pluginId: string) => string = (id) => id,
): string {
  const names = list(outcome.failed.map((f) => nameOf(f.pluginId)));
  const plural = outcome.failed.length > 1;
  if (outcome.coreWiped === null) {
    return (
      `The reset did not finish${outcome.error ? `: ${outcome.error}` : ''}. ` +
      `It could not be confirmed whether your accounts and search index were ` +
      `already deleted. Reset again to finish.`
    );
  }
  if (outcome.coreWiped) {
    if (outcome.ok) return 'All local data was wiped.';
    const problems: string[] = [];
    if (outcome.failed.length) {
      problems.push(
        `${names} did not start again and need${plural ? '' : 's'} recovery`,
      );
    }
    if (outcome.error)
      problems.push(`a follow-up step failed: ${outcome.error}`);
    return `All local data was wiped, but ${problems.join('; ')}.`;
  }
  const why = outcome.failed.length
    ? `: ${names} could not be reset`
    : outcome.error
      ? `: ${outcome.error}`
      : '';
  return (
    `The reset did not finish${why}. Your accounts and search index were not ` +
    `touched, but data of extensions reset before the failure is already ` +
    `deleted. Reset again to finish.`
  );
}
