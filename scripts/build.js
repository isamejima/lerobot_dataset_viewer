#!/usr/bin/env node
/**
 * build.js — bundle src/{index.html,styles.css,app.js,core.js} into a single
 * self-contained dist/lerobot-viewer.html.
 *
 * Zero dependencies. Run with:  node scripts/build.js
 * No `npm install` required.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const srcDir = path.join(root, 'src');
const distDir = path.join(root, 'dist');

function read(p) { return fs.readFileSync(path.join(srcDir, p), 'utf8'); }

const html = read('index.html');
const css = read('styles.css');
let js = read('app.js');
const core = read('core.js');

// app.js imports from './core.js'. For the single-file bundle we inline core.js
// by stripping its `export` keywords and replacing the import statement.
// core's analyzeColumns is exposed to app.js under the alias analyzeColumnsCore,
// so we rename the inlined core function to match the alias and avoid a clash
// with app.js's own analyzeColumns wrapper.
const coreInlined = core
  .replace(/^export\s+/gm, '')
  .replace(/function analyzeColumns\(/, 'function analyzeColumnsCore(');
js = js.replace(
  /import\s*\{[\s\S]*?\}\s*from\s*['"]\.\/core\.js['"];?\n/,
  () => `// ---- inlined from core.js ----\n${coreInlined}\n// ---- end core.js ----\n`
);

// Inline <link rel="stylesheet" href="./styles.css"> -> <style>…</style>
let out = html.replace(
  /<link\s+rel="stylesheet"\s+href="\.\/styles\.css"\s*\/?>/,
  () => `<style>\n${css.trimEnd()}\n</style>`
);

// Inline <script type="module" src="./app.js"></script> -> <script type="module">…</script>
out = out.replace(
  /<script\s+type="module"\s+src="\.\/app\.js"\s*><\/script>/,
  () => `<script type="module">\n${js.trimEnd()}\n</script>`
);

if (out.includes('href="./styles.css"') || out.includes('src="./app.js"')) {
  console.error('✗ build failed: a src reference was not inlined. Check src/index.html tags.');
  process.exit(1);
}

fs.mkdirSync(distDir, { recursive: true });
const outPath = path.join(distDir, 'lerobot-viewer.html');
fs.writeFileSync(outPath, out);

const kb = (Buffer.byteLength(out) / 1024).toFixed(1);
console.log(`✓ built dist/lerobot-viewer.html (${kb} KB)`);
