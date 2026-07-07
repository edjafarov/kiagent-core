/**
 * Local Folder Source — pull-based port of legacy kiagent-ref's local-folder
 * connector. See local-folder-source.ts / cursor.ts for design notes.
 */
export { localFolderSource } from './local-folder-source';
export { DEFAULT_EXCLUDE_GLOBS } from './exclude-globs';
export type { LocalFolderCursor } from './cursor';
export type { LocalFolderItem } from './to-document';
