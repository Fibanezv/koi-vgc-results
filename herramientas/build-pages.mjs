import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const origin = new URL(process.argv[2] || process.env.PAGES_BACKEND_ORIGIN || 'https://koi.85.208.21.215.sslip.io');
const local = origin.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(origin.hostname);
if (origin.href !== origin.origin + '/' || (origin.protocol !== 'https:' && !local)) {
  throw new Error('Usa el origen HTTPS del servidor sin rutas ni parámetros.');
}
const output = path.resolve('build/pages');
await mkdir(output, { recursive: true });
const rules = `default-src 'self'; script-src 'self'; style-src 'self'; connect-src ${origin.origin}; img-src 'self' blob: ${origin.origin}; media-src 'self' blob: ${origin.origin}; frame-src 'self'; base-uri 'none'; object-src 'none'; form-action 'none'`;
const versions = new Map();
for (const name of ['panel.css', 'overlay.css', 'panel.js', 'overlay.js']) {
  const css = name.endsWith('.css');
  const source = await readFile(path.join(css ? 'ui' : 'build', name), 'utf8');
  const asset = css ? source.replaceAll("url('/", "url('./") : source;
  await writeFile(path.join(output, name), asset);
  const version = createHash('sha256').update(asset).digest('hex').slice(0, 12);
  versions.set(name, version);
}
for (const name of ['index.html', 'panel.html', 'overlay.html']) {
  const source = await readFile(path.join('ui', name), 'utf8');
  const html = source
    .replace(/^\s*<meta http-equiv="Content-Security-Policy"[^>]*>\r?\n/m, '\n')
    .replace('<head>', `<head>
  <meta name="app-origin" content="${origin.origin}">
  <meta name="referrer" content="no-referrer">
  <meta http-equiv="Content-Security-Policy" content="${rules}">`)
    .replace(/\b(href|src)="\/(panel|overlay)\.(css|js)(?:\?[^"]*)?"/g, (_match, attr, stem, extension) => {
      const asset = `${stem}.${extension}`;
      return `${attr}="./${asset}?v=${versions.get(asset)}"`;
    })
    .replace(/\b(href|src)="\/(?=[^/])/g, '$1="./');
  await writeFile(path.join(output, name), html);
}
await Promise.all([
  copyFile('ui/koi-logo.jpg', path.join(output, 'koi-logo.jpg')),
  // El HTML anterior puede seguir en caché y pedir esta hoja.
  copyFile('docs/estilos.css', path.join(output, 'estilos.css')),
  writeFile(path.join(output, '.nojekyll'), ''),
]);
