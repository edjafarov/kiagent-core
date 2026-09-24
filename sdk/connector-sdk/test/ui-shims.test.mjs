import { test } from 'node:test';
import assert from 'node:assert/strict';

test('ui shims re-export the host React instance', async () => {
  const React = { useState() {}, createElement() {} };
  const ReactDOM = { createPortal() {}, flushSync() {} };
  const jsxRuntime = { jsx() {}, jsxs() {}, Fragment: 'F' };
  globalThis.__kiaHost = { React, ReactDOM, jsxRuntime };
  const r = await import('../ui-shims/react.js');
  assert.equal(r.default, React);
  assert.equal(r.useState, React.useState);
  assert.equal(r.createElement, React.createElement);
  assert.equal((await import('../ui-shims/react-dom.js')).createPortal, ReactDOM.createPortal);
  const j = await import('../ui-shims/jsx-runtime.js');
  assert.equal(j.jsx, jsxRuntime.jsx);
  assert.equal(j.Fragment, 'F');
});
