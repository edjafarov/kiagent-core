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

/** The next manifest revision, taken inside the statement that commits it, so
 *  that two writers in a row (a scan and an accepted offer) can never share
 *  one: the source's `rev > cursor` would skip the second forever. */
export const NEXT_REV = `(SELECT COALESCE(MAX(rev), 0) + 1 FROM shared_files)`;

/** Operations this Mac has done or noted that the next scan must still account
 *  for. Local; a row is deleted only in the transaction that commits what it
 *  explains. `moved` and `removed`: a file this device itself moved (sorting)
 *  or removed (a mirrored deletion) from `root/rel_path`, so that its absence is
 *  explained. `note`: a phone capture's file (`capture_id`) at `root/rel_path`
 *  with these bytes, not yet attached to a mirror entry. */
export const SHARED_PENDING_DDL = `
  CREATE TABLE IF NOT EXISTS shared_pending (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    root TEXT NOT NULL,
    rel_path TEXT NOT NULL,
    sha256 TEXT NOT NULL DEFAULT '',
    to_root TEXT,
    to_rel TEXT,
    capture_id TEXT
  );
  CREATE INDEX IF NOT EXISTS shared_pending_path ON shared_pending(root, rel_path);
`;
