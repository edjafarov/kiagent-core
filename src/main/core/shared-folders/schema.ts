/** Tables of the shared folders (phone phase 3). `shared_files` and
 *  `shared_capture_files` are copied to every device and written by the leader;
 *  `shared_mirror` is local to each Mac. */
export const SHARED_FOLDERS_DDL = `
  CREATE TABLE IF NOT EXISTS shared_files (
    root TEXT NOT NULL,
    rel_path TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    bytes INTEGER NOT NULL,
    mtime TEXT NOT NULL,
    missing_here INTEGER NOT NULL DEFAULT 0,
    deleted INTEGER NOT NULL DEFAULT 0,
    parked INTEGER NOT NULL DEFAULT 0,
    rev INTEGER NOT NULL,
    PRIMARY KEY (root, rel_path)
  );
  CREATE INDEX IF NOT EXISTS shared_files_rev ON shared_files(rev);
  CREATE TABLE IF NOT EXISTS shared_capture_files (
    capture_id TEXT PRIMARY KEY,
    sha256 TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS shared_mirror (
    root TEXT NOT NULL,
    rel_path TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    bytes INTEGER NOT NULL,
    mtime_ms INTEGER NOT NULL,
    capture_id TEXT,
    PRIMARY KEY (root, rel_path)
  );
`;
