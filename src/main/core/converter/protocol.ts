import type { ContainerKind, ExpandBudget } from './containers/types';

/** Parent ↔ `kia-converter` child messages (#136). Bytes travel as a
 *  structured-clone copy (utilityProcess postMessage; child_process.fork
 *  with serialization 'advanced' in tests) — never JSON. */
export type ConverterJob =
  | { op: 'parseDetailed'; bytes: Uint8Array; mime: string; filename?: string }
  | { op: 'parsePdfPages'; bytes: Uint8Array }
  | {
      op: 'rasterizePdf';
      bytes: Uint8Array;
      pages: number[];
      maxEdge?: number;
    }
  | {
      /** Path-based: the child reads the container itself; no bytes
       *  cross the boundary. */
      op: 'expandPage';
      path: string;
      kind: ContainerKind;
      resume: unknown | null;
      budget: ExpandBudget;
    };

export type ConverterRequest = ConverterJob & { id: number };

export type ConverterReply =
  | { t: 'ready' }
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; name: string; message: string };
