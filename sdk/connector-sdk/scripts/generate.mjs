import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const sdkRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const coreShared = join(sdkRoot, '..', '..', 'src', 'shared');
const outDir = join(sdkRoot, 'src', 'generated');
mkdirSync(outDir, { recursive: true });
for (const f of ['contracts.ts', 'source-errors.ts', 'file-indexability.ts']) {
  copyFileSync(join(coreShared, f), join(outDir, f));
}
