import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const sdkRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const coreShared = join(sdkRoot, '..', '..', 'src', 'shared');
const outDir = join(sdkRoot, 'src', 'generated');
mkdirSync(outDir, { recursive: true });
// Copy the direct dependency closure of contracts.ts as well. These are
// shared contracts, not SDK-specific handwritten declarations.
for (const f of [
  'contracts.ts',
  'source-errors.ts',
  'file-indexability.ts',
  'message-evidence.ts',
  'plugin-db.ts',
  'plugin-files.ts',
  'plugin-net.ts',
  'plugin-sql.ts',
]) {
  copyFileSync(join(coreShared, f), join(outDir, f));
}
