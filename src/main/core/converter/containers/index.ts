/** `expandPage` dispatch: one bounded page of children from a container
 *  read by path. Pure (converter child). */
import { expandEnex, type EnexResume } from './enex';
import { expandMbox, type MboxResume } from './mbox';
import { expandPst, type PstResume } from './pst';
import { expandVcard, type VcardResume } from './vcard';
import { expandZip, type ZipResume } from './zip';
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
    case 'vcard':
      return expandVcard(path, resume as VcardResume | null, budget);
    case 'enex':
      return expandEnex(path, resume as EnexResume | null, budget);
    case 'zip':
      return expandZip(path, resume as ZipResume | null, budget);
    case 'pst':
      return expandPst(path, resume as PstResume | null, budget);
    default:
      throw new Error(`expander not implemented: ${kind} (${path})`);
  }
}
