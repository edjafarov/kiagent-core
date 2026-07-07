/**
 * Generate every raster brand asset from the SVG sources in assets/brand/.
 * Run with: npm run brand:generate
 *
 * Outputs (all committed to git):
 *   assets/icon.png .ico .icns + assets/icon.svg (copy of brand/spark.svg)
 *   assets/icons/<N>x<N>.png for N in {16,24,32,48,64,96,128,256,512,1024}
 *   assets/icons/tray/tray{,Live,LiveBright,Error,Paused}{Template,}{,@2x}.png
 *
 * App-icon grade (brand spec, Bracket §09 degradation rule): icons ≥ 48px use
 * brand/spark.svg (the reticle tile, with corner ticks); smaller sizes use
 * brand/spark-tile.svg (the plain Spark tile), where the ticks can't survive.
 * The tray stays the bare Spark silhouette at every size.
 */
import { promises as fs } from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import sharp from 'sharp';
import pngToIco from 'png-to-ico';

const ROOT = path.resolve(__dirname, '..');
const BRAND = path.join(ROOT, 'assets', 'brand');
const ICONS = path.join(ROOT, 'assets', 'icons');
const TRAY = path.join(ICONS, 'tray');
const ASSETS = path.join(ROOT, 'assets');

const DOCK_SIZES = [16, 24, 32, 48, 64, 96, 128, 256, 512, 1024];

// The app-icon tile masters. ≥ 48px renders the reticle tile (corner ticks);
// below that the ticks alias into mush, so the plain Spark tile is used
// (brand spec, Bracket §09 degradation rule).
const TILE_TICKS = path.join(BRAND, 'spark.svg'); // reticle tile, ≥ 48px
const TILE_PLAIN = path.join(BRAND, 'spark-tile.svg'); // plain tile, < 48px
const tileFor = (px: number): string => (px >= 48 ? TILE_TICKS : TILE_PLAIN);

async function rasterize(svgPath: string, size: number): Promise<Buffer> {
  const svg = await fs.readFile(svgPath);
  return sharp(svg, { density: 384 }).resize(size, size).png().toBuffer();
}

async function writeBuf(p: string, buf: Buffer): Promise<void> {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, buf);
  console.log('wrote', path.relative(ROOT, p));
}

async function generateDockIcons(): Promise<void> {
  for (const size of DOCK_SIZES) {
    await writeBuf(
      path.join(ICONS, `${size}x${size}.png`),
      await rasterize(tileFor(size), size),
    );
  }
  // Top-level icon.png (electron-builder reads this as the 1024px master)
  await writeBuf(
    path.join(ASSETS, 'icon.png'),
    await rasterize(TILE_TICKS, 1024),
  );
  // icon.svg = copy of the reticle-tile brand source (the primary large mark)
  await fs.copyFile(TILE_TICKS, path.join(ASSETS, 'icon.svg'));
  console.log('copied assets/icon.svg');
}

async function generateIco(): Promise<void> {
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const buffers: Buffer[] = [];
  for (const s of sizes) {
    buffers.push(await rasterize(tileFor(s), s));
  }
  const ico = await pngToIco(buffers);
  await writeBuf(path.join(ASSETS, 'icon.ico'), ico);
}

async function generateIcns(): Promise<void> {
  if (process.platform !== 'darwin') {
    console.warn(
      'skipping icon.icns generation (not macOS; iconutil unavailable)',
    );
    return;
  }
  const iconset = path.join(ASSETS, '.tmp-iconset.iconset');
  await fs.mkdir(iconset, { recursive: true });
  const pairs: Array<[string, number]> = [
    ['icon_16x16.png', 16],
    ['icon_16x16@2x.png', 32],
    ['icon_32x32.png', 32],
    ['icon_32x32@2x.png', 64],
    ['icon_128x128.png', 128],
    ['icon_128x128@2x.png', 256],
    ['icon_256x256.png', 256],
    ['icon_256x256@2x.png', 512],
    ['icon_512x512.png', 512],
    ['icon_512x512@2x.png', 1024],
  ];
  for (const [name, size] of pairs) {
    await writeBuf(
      path.join(iconset, name),
      await rasterize(tileFor(size), size),
    );
  }
  execFileSync(
    'iconutil',
    ['-c', 'icns', '-o', path.join(ASSETS, 'icon.icns'), iconset],
    {
      stdio: 'inherit',
    },
  );
  await fs.rm(iconset, { recursive: true, force: true });
  console.log('wrote assets/icon.icns');
}

async function generateTrayIcons(): Promise<void> {
  const variants: Array<{ basename: string; svg: string }> = [
    { basename: 'trayTemplate', svg: 'spark-mono.svg' },
    { basename: 'trayPausedTemplate', svg: 'spark-mono-paused.svg' },
    { basename: 'trayLive', svg: 'spark-mono-live.svg' },
    { basename: 'trayLiveBright', svg: 'spark-mono-live-bright.svg' },
    { basename: 'trayError', svg: 'spark-mono-error.svg' },
  ];
  for (const v of variants) {
    const src = path.join(BRAND, v.svg);
    await writeBuf(
      path.join(TRAY, `${v.basename}.png`),
      await rasterize(src, 16),
    );
    await writeBuf(
      path.join(TRAY, `${v.basename}@2x.png`),
      await rasterize(src, 32),
    );
  }
}

async function generateMcpServerIcon(): Promise<void> {
  // Embed the 256×256 app-icon tile as a base64 data URI in a TS module so the
  // bundled MCP server (webpacked into both main.js and mcpStdio.js) can
  // advertise it in the `initialize` handshake (serverInfo.icons) with NO
  // runtime file access — the stdio server runs headless via
  // ELECTRON_RUN_AS_NODE and can't rely on the asar/resources layout. Reads the
  // PNG generateDockIcons() already wrote, so it tracks the brand mark.
  const png = await fs.readFile(path.join(ICONS, '256x256.png'));
  const dataUri = `data:image/png;base64,${png.toString('base64')}`;
  const out = path.join(ROOT, 'src', 'main', 'core', 'mcp', 'server-icon.ts');
  const moduleText = [
    '/* eslint-disable */',
    '// GENERATED by `npm run brand:generate` — do not edit by hand.',
    '// Base64 data URI of assets/icons/256x256.png, advertised as the MCP',
    "// server's icon in the `initialize` handshake (serverInfo.icons).",
    '// See src/main/core/mcp/make-server.ts.',
    `export const KIA_SERVER_ICON_DATA_URI =\n  '${dataUri}';`,
    '',
  ].join('\n');
  await fs.writeFile(out, moduleText);
  console.log('wrote', path.relative(ROOT, out));
}

async function main(): Promise<void> {
  await generateDockIcons();
  await generateIco();
  await generateIcns();
  await generateTrayIcons();
  await generateMcpServerIcon();
  console.log('done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
