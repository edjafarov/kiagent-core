/**
 * Shared by `FolderPickerField`'s debounced under-field count line and
 * `FolderPickerModal`'s per-row count badges — one place for the copy so the
 * two surfaces can never drift. Ports the ref app's copy verbatim:
 * "1,234 files", "1 file", "50,000+ files".
 */
export function formatCount(count: number, capped: boolean): string {
  const num = count.toLocaleString();
  return capped ? `${num}+ files` : `${num} ${count === 1 ? 'file' : 'files'}`;
}
