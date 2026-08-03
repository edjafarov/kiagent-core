/**
 * Stages `@shared/web-ui`'s CSS files next to the compiled Electron main
 * bundle.
 *
 * `src/shared/web-ui/loader-node.ts` (`loadShellCss`) reads its CSS with
 * `readFileSync(join(__dirname, name))` at runtime — it expects the CSS files
 * to sit alongside the compiled `loader-node.js`. That's true in jest
 * (ts-jest keeps `__dirname` at the real source-tree location) and in
 * Node-hosted consumers with their own copy step, but webpack's main-process
 * build only emits `.js`/`.map` for the main bundle: nothing stages the CSS
 * next to it. Since both main configs set `node.__dirname = false`,
 * `__dirname` at runtime resolves to the bundle's own output directory
 * (`.erb/dll` in dev, `release/app/dist/main` in prod) — so without this,
 * `loadShellCss()` throws ENOENT the first time any outbound confirm/link
 * page is rendered in a real (non-jest) run. (`src/main/outbound/pages.ts`
 * catches that throw and falls back to an unstyled-but-functional page, so
 * this was a styling gap, not a crash — see task-8's discovery.)
 *
 * Copies every `.css` file in the shared web-ui package (not just the ones
 * `pages.ts` currently uses) so any future `loadShellCss(variant)` call from
 * main-process code keeps working without another webpack change.
 */
import path from 'path';
import CopyWebpackPlugin from 'copy-webpack-plugin';
import webpackPaths from './webpack.paths';

export default function copySharedCssPlugin(): CopyWebpackPlugin {
  return new CopyWebpackPlugin({
    patterns: [
      {
        // POSIX separators, always: copy-webpack-plugin globs via fast-glob,
        // where `\` is an ESCAPE character, not a separator. path.join emits
        // backslashes on Windows, so this pattern matched nothing there and
        // noErrorOnMissing:false turned that into a hard build failure —
        // `unable to locate '...\src\shared\web-ui\*.css' glob`. No Windows
        // product build could complete until this was fixed.
        from: path
          .join(webpackPaths.srcPath, 'shared/web-ui/*.css')
          .replace(/\\/g, '/'),
        to: '[name][ext]',
        noErrorOnMissing: false,
      },
    ],
  });
}
