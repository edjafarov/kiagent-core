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
  dev: string;
  ino: string;
  nlink: number;
  mode: number;
  symbolicLink: boolean;
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
  lstat(ref: FileRef): Promise<FileInfo>;
  canonical(ref: FileRef): Promise<FileRef>;
  mkdir(ref: FileRef): Promise<void>;
  open(ref: FileRef, mode: 'r' | 'wx'): Promise<ScopedFileHandle>;
  fstat(handle: ScopedFileHandle): Promise<FileInfo>;
  readHandle(
    handle: ScopedFileHandle,
    options: { offset: number; maxBytes: number },
  ): Promise<Uint8Array>;
  writeHandle(handle: ScopedFileHandle, data: Uint8Array): Promise<void>;
  syncHandle(handle: ScopedFileHandle): Promise<void>;
  setHandleMetadata(
    handle: ScopedFileHandle,
    metadata: { mode?: number; atimeMs?: number; mtimeMs?: number },
  ): Promise<void>;
  closeHandle(handle: ScopedFileHandle): Promise<void>;
  link(from: FileRef, to: FileRef): Promise<void>;
  list(
    ref: FileRef,
    options?: { cursor?: string; limit?: number },
  ): Promise<{ entries: FileEntry[]; nextCursor?: string }>;
  read(
    ref: FileRef,
    options?: { offset?: number; maxBytes?: number },
  ): Promise<Uint8Array>;
  write(
    ref: FileRef,
    data: Uint8Array,
    options?: { ifAbsent?: boolean },
  ): Promise<void>;
  move(from: FileRef, to: FileRef): Promise<void>;
  remove(ref: FileRef): Promise<void>;
  watch(
    ref: FileRef,
    onChange: (event: FileChange) => void,
  ): Promise<{ close(): Promise<void> }>;
}

export interface ScopedFileHandle {
  id: string;
}
