'use strict';

// Render build/icon.svg to a 1024x1024 PNG using Electron (no external
// rasterizer needed). build-icon.sh then slices it into an .icns.

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const SIZE = 1024;
const root = path.join(__dirname, '..');
const svg = fs.readFileSync(path.join(root, 'build', 'icon.svg'), 'utf8');
const html = `<!doctype html><html><head><meta charset="utf-8">
<style>html,body{margin:0;padding:0;background:transparent}
svg{display:block;width:${SIZE}px;height:${SIZE}px}</style>
</head><body>${svg}</body></html>`;

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: SIZE,
    height: SIZE,
    useContentSize: true,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
  });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  await new Promise((r) => setTimeout(r, 500)); // let it paint
  const img = await win.webContents.capturePage();
  const out = path.join(root, 'build', 'icon.png');
  fs.writeFileSync(out, img.toPNG());
  const { width, height } = img.getSize();
  console.log(`wrote ${out} (${width}x${height})`);
  // On Retina the capture is 2x (e.g. 2048) — that's a fine, crisper source.
  app.exit(width >= SIZE ? 0 : 1);
});
