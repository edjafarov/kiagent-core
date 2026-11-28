// scripts/sync-app-lock-version.mjs — release-it's after:bump hook; see
// app-lock-version.mjs for why.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { syncAppLockVersion } from './app-lock-version.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const changed = syncAppLockVersion(path.join(root, 'release', 'app'));
console.log(
  changed
    ? 'release/app/package-lock.json version synced'
    : 'release/app/package-lock.json already in sync',
);
