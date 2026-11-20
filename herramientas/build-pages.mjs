import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const origin = new URL(process.argv[2] || process.env.PAGES_BACKEND_ORIGIN || 'https://koi.85.208.21.215.sslip.io');
const local = origin.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(origin.hostname);
if (origin.href !== origin.origin + '/' || (origin.protocol !== 'https:' && !local)) {
  throw new Error('Usa el origen HTTPS del servidor sin rutas ni parámetros.');
}
const output = path.resolve('build/pages');
await mkdir(output, { recursive: true });
const rules = `default-src 'self'; script-src 'self'; style-src 'self'; connect-src ${origin.origin}; img-src 'self' blob: ${origin.origin}; media-src 'self' blob: ${origin.origin}; frame-src 'self'; base-uri 'none'; object-src 'none'; form-action 'none'`;
for (const name of ['index.html', 'panel.html', 'overlay.html']) {
  const source = await readFile(path.join('ui', name), 'utf8');
  const html = source
    .replace(/^\s*<meta http-equiv="Content-Security-Policy"[^>]*>\r?\n/m, '\n')
    .replace('<head>', `<head>
  <meta name="app-origin" content="${origin.origin}">
  <meta name="referrer" content="no-referrer">
  <meta http-equiv="Content-Security-Policy" content="${rules}">`)
    .replace(/\b(href|src)="\/(?=[^/])/g, '$1="./');
  await writeFile(path.join(output, name), html);
}
for (const name of ['panel.css', 'overlay.css']) {
  const css = await readFile(path.join('ui', name), 'utf8');
  await writeFile(path.join(output, name), css.replaceAll("url('/", "url('./"));
}
await Promise.all([
  copyFile('ui/koi-logo.jpg', path.join(output, 'koi-logo.jpg')),
  copyFile('build/panel.js', path.join(output, 'panel.js')),
  copyFile('build/overlay.js', path.join(output, 'overlay.js')),
  writeFile(path.join(output, '.nojekyll'), ''),
]);
