import type { RendererApi } from '@shared/ipc';

declare global {
  interface Window {
    kiagent: RendererApi;
  }
}

// Side-effect CSS imports (`import './App.css'`, `import '@shared/web-ui/tokens.css'`).
// Webpack (style-loader/css-loader) resolves these at bundle time; this
// ambient declaration only exists so `tsc -p tsconfig.typecheck.json`
// (moduleResolution: bundler, but still a real type-checker) doesn't reject
// the import as an unresolvable module. No `?raw` variant is declared here —
// the renderer never needs the raw-string CSS loader trick that
// @shared/web-ui/loader-electron.ts uses for main-process consent templates;
// plain imports are enough (per task instructions, preferred over the raw
// loader trick anyway).
declare module '*.css';
