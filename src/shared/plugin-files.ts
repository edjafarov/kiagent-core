export interface FileRef {
  root: string;
  rel: string;
}

export interface FileRoot {
  id: string;
  name: string;
  writable: boolean;
}

export interface FileInfo {
  kind: 'file' | 'directory' | 'other';
  size: number;
  mtimeMs: number;
}

export interface FileEntry extends FileInfo {
  name: string;
}

export interface FileChange {
  ref: FileRef;
  kind: 'changed' | 'removed' | 'rescan';
}

export interface ScopedFiles {
  roots(): Promise<FileRoot[]>;
  stat(ref: FileRef): Promise<FileInfo>;
  list(
    ref: FileRef,
    options?: { cursor?: string; limit?: number },
  ): Promise<{ entries: FileEntry[]; nextCursor?: string }>;
  read(ref: FileRef, options?: { offset?: number; maxBytes?: number }): Promise<Uint8Array>;
  write(ref: FileRef, data: Uint8Array, options?: { ifAbsent?: boolean }): Promise<void>;
  move(from: FileRef, to: FileRef): Promise<void>;
  remove(ref: FileRef): Promise<void>;
  watch(ref: FileRef, onChange: (event: FileChange) => void): Promise<{ close(): Promise<void> }>;
}
