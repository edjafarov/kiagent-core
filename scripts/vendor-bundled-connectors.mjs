// Copy locally-built bundled connectors into assets/bundled-connectors/<id>/ so
// dev (npm start) and packaging (electron-builder `extraResources: ./assets/**`)
// ship them. Source = sibling connector checkouts' built dist + manifest. NOT
// wired into CI (same as the deep-extraction vendor scripts) — run manually
// before packaging. See [[deep-extraction-subproject-c]] for the CI follow-up.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONNECTORS = [
  { id: 'kia.whatsapp', src: path.resolve(repoRoot, '..', 'whatsapp-kia-connector') },
];

for (const c of CONNECTORS) {
  const srcManifest = path.join(c.src, 'manifest.json');
  const srcBundle = path.join(c.src, 'dist', 'index.js');
  if (!fs.existsSync(srcManifest) || !fs.existsSync(srcBundle)) {
    console.warn(`[vendor-bundled-connectors] ${c.id}: source not found at ${c.src} (skipped)`);
    continue;
  }
  const destDir = path.join(repoRoot, 'assets', 'bundled-connectors', c.id);
  fs.mkdirSync(path.join(destDir, 'dist'), { recursive: true });
  fs.copyFileSync(srcManifest, path.join(destDir, 'manifest.json'));
  fs.copyFileSync(srcBundle, path.join(destDir, 'dist', 'index.js'));
  console.log(`[vendor-bundled-connectors] ${c.id}: vendored`);
}
