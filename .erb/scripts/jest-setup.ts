// jest setup: polyfills jsdom lacks. No test reads the webpack bundles, so the
// suite runs on a fresh clone without `npm run build` first.
import { TextEncoder, TextDecoder } from 'node:util';

// JSDOM does not implement TextEncoder and TextDecoder
if (!global.TextEncoder) {
  global.TextEncoder = TextEncoder;
}
if (!global.TextDecoder) {
  // @ts-ignore
  global.TextDecoder = TextDecoder;
}
