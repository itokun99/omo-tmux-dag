import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR = join(root, 'qa', 'vendor');
const XTERM = 'https://unpkg.com/@xterm/xterm@5.5.0';

async function ensureVendor() {
  const targets = [[`${XTERM}/lib/xterm.js`, join(VENDOR, 'xterm.js')], [`${XTERM}/css/xterm.css`, join(VENDOR, 'xterm.css')]];
  for (const [url, path] of targets) {
    try { await readFile(path); continue; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const response = await fetch(url);
    if (!response.ok) throw new Error(`cannot fetch ${url}: HTTP ${response.status}`);
    await Bun.write(path, await response.text());
  }
}

await ensureVendor();
const [capturePath, outPath, cols = '70', rows = '50'] = process.argv.slice(2);
if (!capturePath || !outPath) throw new Error('Usage: bun qa/screenshot.mjs <capture.ansi> <out.png> [cols] [rows]');
const capture = await readFile(capturePath, 'utf8');
const url = `file://${join(root, 'qa', 'render-capture.html')}?cols=${cols}&rows=${rows}`;
await using view = new Bun.WebView({ width: Number(cols) * 9 + 32, height: Number(rows) * 17 + 32 });
await view.navigate(url);
if (!(await view.evaluate('typeof window.__render === "function"'))) throw new Error('render hook missing');
await view.evaluate(`window.__render(${JSON.stringify(capture)})`);
const rendered = await view.evaluate('window.__term.buffer.active.length');
if (!rendered) throw new Error('terminal buffer stayed empty');
await view.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))');
await Bun.write(outPath, await view.screenshot());
console.log(JSON.stringify({ capturePath, outPath, bytes: capture.length, bufferLines: rendered }));
