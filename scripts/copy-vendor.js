'use strict';

// Copies the browser builds of xterm + addons into renderer/vendor so the
// renderer can load them under a strict same-origin CSP (no node_modules
// traversal, no bundler). Run automatically on `npm install` (postinstall).

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const dest = path.join(root, 'renderer', 'vendor');
fs.mkdirSync(dest, { recursive: true });

const files = [
  ['@xterm/xterm/lib/xterm.js', 'xterm.js'],
  ['@xterm/xterm/css/xterm.css', 'xterm.css'],
  ['@xterm/addon-fit/lib/addon-fit.js', 'addon-fit.js'],
];

for (const [src, out] of files) {
  const from = path.join(root, 'node_modules', src);
  const to = path.join(dest, out);
  fs.copyFileSync(from, to);
  console.log('vendored', out);
}
