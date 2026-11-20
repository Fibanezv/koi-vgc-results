import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { createService } from './server.ts';
import { token } from './store.ts';

const production = process.env.NODE_ENV === 'production';
const port = Number(process.env.PORT ?? 38470);
const host = process.env.HOST ?? (production ? '0.0.0.0' : '127.0.0.1');
const root = path.resolve(__dirname, '..');
const configured = process.env.PUBLIC_ORIGIN;
const origin = new URL(configured ?? `http://127.0.0.1:${port}`);
if (!Number.isInteger(port) || port < 1 || port > 65535
    || origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password
    || !['http:', 'https:'].includes(origin.protocol) || (production && origin.protocol !== 'https:')) {
  throw new Error('Configura PORT y PUBLIC_ORIGIN con el origen de la web. En producción debe ser HTTPS.');
}
if (!production && !['127.0.0.1', '::1', 'localhost'].includes(host) && !process.env.ACCESS_CODES) {
  throw new Error('Configura ACCESS_CODES antes de permitir conexiones desde la red.');
}
const codes: unknown = process.env.ACCESS_CODES ? JSON.parse(process.env.ACCESS_CODES) : production ? null : { local: token() };
if (!codes || typeof codes !== 'object' || Array.isArray(codes)
    || !Object.keys(codes).length || Object.keys(codes).length > 100
    || !Object.entries(codes).every(([owner, code]) => /^[a-z0-9-]{1,64}$/.test(owner)
      && typeof code === 'string' && /^[A-Za-z0-9_-]{32,256}$/.test(code))
    || new Set(Object.values(codes)).size !== Object.keys(codes).length) {
  throw new Error('ACCESS_CODES debe contener cuentas únicas y códigos aleatorios distintos de al menos 32 caracteres.');
}
const dir = path.resolve(process.env.DATA_DIR ?? path.join(root, 'data'));
const pagesOrigin = process.env.PAGES_ORIGIN;
if (pagesOrigin && (new URL(pagesOrigin).origin !== pagesOrigin || !pagesOrigin.startsWith('https://'))) {
  throw new Error('PAGES_ORIGIN debe ser un origen HTTPS sin ruta ni parámetros.');
}
mkdirSync(dir, { recursive: true, mode: 0o700 });
const service = createService({ origin: origin.origin, dataPath: path.join(dir, 'results.sqlite'), codes: codes as Record<string, string>, root,
  mediaRoot: process.env.MEDIA_DIR ? path.resolve(process.env.MEDIA_DIR) : undefined, pagesOrigin });
const server = service.app.listen(port, host, () => {
  console.log(`Panel disponible en ${origin.origin}`);
  if (!production && !process.env.ACCESS_CODES) console.log(`Código de acceso temporal para este arranque: ${(codes as Record<string, string>).local}`);
});
let closing = false;
function stop() {
  if (closing) return;
  closing = true;
  server.close();
  void service.close().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
}
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
