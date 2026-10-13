/** `expandPage` dispatch: one bounded page of children from a container
 *  read by path. Pure (converter child). */
import type { ContainerKind, ExpandBudget, ExpandResult } from './types';

export async function expandPage(
  path: string,
  kind: ContainerKind,
  _resume: unknown | null,
  _budget: ExpandBudget,
): Promise<ExpandResult> {
  switch (kind) {
    default:
      throw new Error(`expander not implemented: ${kind} (${path})`);
  }
}
