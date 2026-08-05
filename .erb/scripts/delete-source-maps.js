import fs from 'fs';
import path from 'path';
import { rimrafSync } from 'rimraf';
import webpackPaths from '../configs/webpack.paths';

// POSIX separators, always: rimraf's `glob: true` treats `\` as an ESCAPE
// character, not a separator, so the backslash paths path.join emits on Windows
// matched nothing and this swept no files at all there. Effect is limited —
// both prod configs set `devtool: 'source-map'` and re-emit the maps anyway, so
// the only casualty was orphaned maps from chunks that no longer exist — but
// the clean step silently did nothing on Windows.
const globPath = (...parts) => path.join(...parts).replace(/\\/g, '/');

export default function deleteSourceMaps() {
  if (fs.existsSync(webpackPaths.distMainPath))
    rimrafSync(globPath(webpackPaths.distMainPath, '*.js.map'), {
      glob: true,
    });
  if (fs.existsSync(webpackPaths.distRendererPath))
    rimrafSync(globPath(webpackPaths.distRendererPath, '*.js.map'), {
      glob: true,
    });
}
