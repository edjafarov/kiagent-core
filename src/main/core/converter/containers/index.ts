/** `expandPage` dispatch: one bounded page of children from a container
 *  read by path. Pure (converter child). */
import { expandMbox, type MboxResume } from './mbox';
import type { ContainerKind, ExpandBudget, ExpandResult } from './types';

export async function expandPage(
  path: string,
  kind: ContainerKind,
  resume: unknown | null,
  budget: ExpandBudget,
): Promise<ExpandResult> {
  switch (kind) {
    case 'mbox':
      return expandMbox(path, resume as MboxResume | null, budget);
    default:
      throw new Error(`expander not implemented: ${kind} (${path})`);
  }
}
