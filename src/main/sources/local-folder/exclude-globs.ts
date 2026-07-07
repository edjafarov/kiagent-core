/**
 * Default glob patterns excluded from every local-folder scan/watch.
 *
 * Verbatim port of kiagent-ref's `DEFAULT_EXCLUDE_GLOBS`
 * (kiagent-ref src/main/connectors/local-folder/exclude-globs.ts:8-17). Legacy
 * scans with `dot: true` (dotfiles ARE indexed) and relies on this list to
 * keep out specific junk directories/files rather than dotfiles wholesale —
 * preserved unchanged here.
 */
export const DEFAULT_EXCLUDE_GLOBS = [
  '**/.git/**',
  '**/node_modules/**',
  '**/.DS_Store',
  '**/Thumbs.db',
  '**/.Trash/**',
  '**/.cache/**',
  '**/*.tmp',
  '**/*.swp',
];
