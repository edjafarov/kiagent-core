/** The few pst-extractor internals the PST pager needs, in one place.
 *  Pinned to pst-extractor 1.12.0 (exact, package.json); the
 *  `containers-pst` test asserts every member touched here exists.
 *
 *  Why not the public API: `getNextChild()` skips a failing row inside the
 *  library and advances a private cursor (a counted resume drifts), its
 *  fallback path does not catch at all, `getSubFolders()` loads every child
 *  folder at once, the body getters read a whole property before anyone
 *  can look at its size, and `getRecipient(i)` re-reads the whole recipient
 *  table per call (quadratic: a 400-recipient Enron memo took seconds);
 *  `getAttachment(i)` does the same with the attachment table. */
import Long from 'long';
// Only the package root: a deep `pst-extractor/dist/...` import would be
// bundled beside the external package (webpack matches externals by exact
// request), and `instanceof` across the two copies fails.
import { PSTFile, PSTFolder, PSTMessage, PSTRecipient } from 'pst-extractor';

type PSTObject = PSTFolder | PSTMessage;

/** Row property holding a child's descriptor NID (PidTagLtpRowId). */
const ROW_NID = 0x67f2;

interface RowItem {
  entryValueReference: number;
  itemIndex: number;
}
interface Table {
  getItems(start?: number, count?: number): Array<Map<number, RowItem>>;
  rowCount?: number;
}
interface FolderInternals {
  initEmailsTable(): void;
  initSubfoldersTable(): void;
  emailsTable: Table | null;
  fallbackEmailsTable: Array<{ descriptorIdentifier: number }> | null;
  subfoldersTable: Table | null;
}
interface TableItem {
  data: Buffer;
  isExternalValueReference: boolean;
  entryValueReference: number;
}
interface ObjectInternals {
  pstTableItems: Map<number, TableItem> | null;
  localDescriptorItems: Map<
    number,
    { dataSize: number; getData(): Buffer }
  > | null;
}

const internals = (f: PSTFolder) => f as unknown as FolderInternals;

/** NID types (MS-PST 2.2.2.1): normal/search folder, normal message. */
const nidType = (nid: number) => nid & 0x1f;
const NID_FOLDER = 0x02;
const NID_MESSAGE = 0x04;

const nodeOf = (pst: PSTFile, nid: number) =>
  pst.getDescriptorIndexNode(Long.fromNumber(nid));

/** A normal folder by NID (search folders and anything else: null). */
export function loadFolder(pst: PSTFile, nid: number): PSTFolder | null {
  if (nidType(nid) !== NID_FOLDER) return null;
  return new PSTFolder(pst, nodeOf(pst, nid));
}

/** A message by NID; the public constructor loads its property table. */
function loadMessage(pst: PSTFile, nid: number): PSTMessage | null {
  if (nidType(nid) !== NID_MESSAGE) return null;
  return new PSTMessage(pst, nodeOf(pst, nid));
}

/** Rows a folder's contents table can hold: the larger of the table's row
 *  count and PR_CONTENT_COUNT (either may understate). */
export function rowLimit(folder: PSTFolder): number {
  const t = internals(folder).emailsTable;
  return Math.max(folder.contentCount, t?.rowCount ?? 0);
}

export type ChildAt =
  | { end: true }
  | { end: false; message: PSTMessage | null; skipped: boolean };

/**
 * Row `i` of a folder's contents table. The index is the caller's, never the
 * library's cursor. `message` is null for a non-message (appointment rows
 * load as PSTMessage subclasses; the caller filters by class); `skipped` is
 * true when the row could not be loaded.
 */
export function childAt(pst: PSTFile, folder: PSTFolder, i: number): ChildAt {
  const f = internals(folder);
  try {
    f.initEmailsTable();
  } catch {
    return { end: true };
  }
  let nid: number | null = null;
  if (f.emailsTable) {
    if (i >= rowLimit(folder)) return { end: true };
    let row: RowItem | undefined;
    try {
      row = f.emailsTable.getItems(i, 1)[0]?.get(ROW_NID);
    } catch {
      return { end: false, message: null, skipped: true };
    }
    if (!row || row.itemIndex === -1) return { end: true };
    nid = row.entryValueReference;
  } else if (f.fallbackEmailsTable) {
    const node = f.fallbackEmailsTable[i];
    if (!node || i >= folder.contentCount) return { end: true };
    nid = node.descriptorIdentifier;
  } else return { end: true };
  try {
    return { end: false, message: loadMessage(pst, nid), skipped: false };
  } catch {
    return { end: false, message: null, skipped: true };
  }
}

/** Child folder NIDs `from … from+n` of a folder, without loading them. */
export function subfolderNids(
  folder: PSTFolder,
  from: number,
  n: number,
): number[] {
  // No `hasSubfolders` short-cut: third-party writers leave it stale. A
  // damaged hierarchy table hides that subtree, never the whole PST.
  const f = internals(folder);
  let rows: Array<Map<number, RowItem>>;
  try {
    f.initSubfoldersTable();
    if (!f.subfoldersTable) return [];
    rows = f.subfoldersTable.getItems(from, n);
  } catch {
    return [];
  }
  const out: number[] = [];
  for (const r of rows) {
    const item = r.get(ROW_NID);
    if (item && item.itemIndex !== -1) out.push(item.entryValueReference);
  }
  return out;
}

/** The first `max` recipients, from ONE read of the recipient table. */
export function recipientsOf(
  pst: PSTFile,
  m: PSTMessage,
  max: number,
): PSTRecipient[] {
  const n = m.numberOfRecipients; // builds the table
  const table = (m as unknown as { recipientTable: Table | null })
    .recipientTable;
  if (!table || n === 0) return [];
  return table
    .getItems(0, Math.min(n, max))
    .map(
      (row) =>
        new PSTRecipient(
          pst,
          row as unknown as ConstructorParameters<typeof PSTRecipient>[1],
        ),
    );
}

/** The names of the first `max` attachments. The rows are read ONCE and
 *  handed back to the library's own unbounded `getItems()` calls, so each
 *  `getAttachment(i)` costs its own details table only. */
export function attachmentNamesOf(m: PSTMessage, max: number): string[] {
  const n = m.numberOfAttachments; // builds the table
  const table = (m as unknown as { attachmentTable: Table | null })
    .attachmentTable;
  if (!table || n === 0) return [];
  const rows = table.getItems(0, Math.min(n, max));
  table.getItems = () => rows;
  const names: string[] = [];
  for (let i = 0; i < rows.length; i++) {
    try {
      const a = m.getAttachment(i);
      const name = a.longFilename || a.filename;
      if (name) names.push(name);
    } catch {
      // an unreadable attachment row: the message still counts
    }
  }
  return names;
}

/** A property's stored size, read without materialising it (an external
 *  value costs one 8-byte block header). 0 when absent. */
export function propSize(o: PSTObject, id: number): number {
  const { pstTableItems, localDescriptorItems } =
    o as unknown as ObjectInternals;
  const item = pstTableItems?.get(id);
  if (!item) return 0;
  if (!item.isExternalValueReference) return item.data?.length ?? 0;
  const desc = localDescriptorItems?.get(item.entryValueReference);
  return desc ? desc.dataSize : 0;
}

/** The compressed-RTF property's raw bytes (≤ the caller's size check). */
export function rawProp(o: PSTObject, id: number): Buffer | null {
  const { pstTableItems, localDescriptorItems } =
    o as unknown as ObjectInternals;
  const item = pstTableItems?.get(id);
  if (!item) return null;
  if (item.data?.length > 0) return item.data;
  return localDescriptorItems?.get(item.entryValueReference)?.getData() ?? null;
}

export { PSTFile, PSTFolder, PSTMessage };
