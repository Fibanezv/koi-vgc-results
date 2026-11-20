import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { setTimeout as pause } from 'node:timers/promises';

const wiki = 'https://www.wikidex.net';
const cdn = 'https://images.wikidexcdn.net';
const output = new URL('../../media/pokemon/', import.meta.url);
const formWords = /\b(?:forma|familia|flor|plumaje|tamano|raza|de)\b/g;
const baseForms = new Map([
  ['vivillon', 'floral'],
  ['palafin', 'ingenua'],
  ['florges', 'roja'],
  ['lycanroc', 'diurno']
]);
let lastRequest = 0;

function normalize(value) {
  return value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/['’]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

function attribute(tag, name) {
  const match = tag.match(new RegExp(`\\s${name}=(["'])(.*?)\\1`, 'i'));
  return match?.[2].replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'");
}

async function request(url, origin) {
  await pause(Math.max(0, 750 - (Date.now() - lastRequest)));
  lastRequest = Date.now();
  const response = await fetch(url, {
    headers: { 'User-Agent': 'KOI-VGC-SpriteDownloader/1.0' },
    signal: AbortSignal.timeout(30_000)
  });
  if (!response.ok || new URL(response.url).origin !== origin) {
    await response.body?.cancel();
    const error = new Error(`HTTP ${response.status} al consultar ${url}`);
    error.status = response.status;
    throw error;
  }
  return response;
}

function splitName(name) {
  const [label, suffix = ''] = name.replace(/’/g, "'").split(/\s*\(/);
  const [, species, regional] = label.match(/^(.+) de (Alola|Galar|Hisui|Paldea)$/)
    ?? label.match(/^(Rotom) (.+)$/)
    ?? ['', label, ''];
  const modifiers = normalize(`${regional} ${suffix}`).replace(formWords, ' ').trim().split(/\s+/).filter(Boolean);
  if (species === 'Tauros' && modifiers.join(' ') === 'paldea combate') {
    modifiers[1] = 'combatiente';
  }
  if (species === 'Lycanroc' && modifiers.join(' ') === 'nocturna') {
    modifiers[0] = 'nocturno';
  }
  return { label, species, modifiers };
}

async function findArticle(label, species) {
  for (const query of new Set([label, species])) {
    const search = new URL('/index.php', wiki);
    search.search = new URLSearchParams({ title: 'Especial:Buscar', search: query, go: 'Ir' });
    const response = await request(search, wiki);
    const html = await response.text();
    const title = attribute(html.match(/<link\s+rel="canonical"[^>]*>/i)?.[0] ?? '', 'href');
    const article = title ? new URL(title, wiki) : new URL(response.url);
    if (article.origin === wiki && /^\/wiki\/[^:]+$/.test(decodeURIComponent(article.pathname))) {
      return { html, article };
    }
  }
  throw new Error('WikiDex no abrió una ficha para el nombre buscado');
}

function findVideo(html, article, species, modifiers) {
  const videos = new Map();
  const headings = [...html.matchAll(/<h[2-6]\b[^>]*>[\s\S]*?<\/h[2-6]>/gi)];
  for (const [index, heading] of headings.entries()) {
    if (!/(?:sprite|modelo|icono)/i.test(heading[0])) continue;
    const section = html.slice(heading.index + heading[0].length, headings[index + 1]?.index);
    for (const video of section.matchAll(/(<video\b[^>]*>)([\s\S]*?)<\/video>/gi)) {
      const file = attribute(video[1], 'data-mwtitle');
      if (!file || !/_home(?:[_.-])/i.test(file) || !/\.webm$/i.test(file)) continue;
      const label = normalize(file.replace(/\.webm$/i, '').replace(/_home/i, ' '));
      if (/\b(?:variocolor|shiny|cromatico)\b/.test(label)) continue;
      const sources = [...video[2].matchAll(/<source\b[^>]*>/gi)]
        .map(([tag]) => attribute(tag, 'src'))
        .filter(Boolean).map(src => new URL(src, article))
        .filter(url => url.origin === cdn && url.pathname.endsWith('.webm'));
      const compact = sources.find(url => decodeURIComponent(url.pathname).endsWith(`/${file}.240p.vp9.webm`));
      const original = sources.find(url => decodeURIComponent(url.pathname).endsWith(`/${file}`));
      if (compact || original) videos.set(file, { file, label, source: compact ?? original, compact: Boolean(compact) });
    }
  }

  const base = normalize(species);
  const candidates = [...videos.values()].filter(({ label }) => label === base || label.startsWith(`${base} `));
  if (!modifiers.length) {
    return candidates.find(({ label }) => label === base)
      ?? candidates.find(({ label }) => label === `${base} ${baseForms.get(base)}`);
  }
  const matches = candidates.filter(({ label }) => {
    const details = label.slice(base.length).replace(formWords, ' ').trim().split(/\s+/);
    return details.length === modifiers.length && modifiers.every(word => details.includes(word));
  });
  if (matches.length === 1) return matches[0];
  // WikiDex muestra un único sprite HOME para los tamaños de Gourgeist.
  if (!matches.length && base === 'gourgeist' && ['pequeno', 'normal', 'grande', 'extragrande'].includes(modifiers.join(' '))) {
    return candidates.find(({ label }) => label === base);
  }
  if (!matches.length && modifiers.join(' ') === 'macho' && candidates.some(({ label }) => label === `${base} hembra`)) {
    return candidates.find(({ label }) => label === base);
  }
}

async function download(name) {
  const { label, species, modifiers } = splitName(name);
  const { html, article } = await findArticle(label, species);
  console.log(`${name} → ${article.href}`);
  const video = findVideo(html, article, species, modifiers);
  if (!video) throw new Error('Sin coincidencia inequívoca para un sprite normal de Pokémon HOME');
  if (!video.file.match(/^[\p{L}\p{N} ._’'()-]+\.webm$/u)) throw new Error('Nombre de archivo inesperado');

  const filename = new URL(encodeURIComponent(video.file), output);
  let existing;
  try {
    existing = await readFile(filename);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (existing) {
    console.log(`  Ya existe ${video.file}`);
    return 'existing';
  }

  const response = await request(video.source, cdn);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.subarray(0, 4).toString('hex') !== '1a45dfa3'
    || !buffer.subarray(4, 128).includes(Buffer.from('webm'))) {
    throw new Error('El servidor no devolvió un WebM válido');
  }
  await writeFile(filename, buffer, { flag: 'wx' });
  console.log(`  Guardado ${video.file} (${video.compact ? 'VP9 240p' : 'original'}, ${buffer.length} bytes)`);
  console.log(`  Origen ${video.source.href}`);
  console.log(`  SHA-256 ${createHash('sha256').update(buffer).digest('hex')}`);
  return 'saved';
}

try {
  const { values } = parseArgs({
    options: {
      all: { type: 'boolean' },
      limit: { type: 'string' },
      pokemon: { type: 'string', multiple: true },
      help: { type: 'boolean' }
    }
  });
  if (values.help) {
    console.log('Uso: node descargar.mjs [--pokemon "Nombre" | --limit N | --all]\nPor defecto descarga solo el primer Pokémon de pokemon.txt.');
  } else {
    const limit = Number(values.limit ?? '1');
    if (Object.keys(values).length > 1) throw new Error('Elige una sola opción entre --pokemon, --limit y --all');
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new Error('Usa un entero positivo con --limit');
    }
    const list = await readFile(new URL('./pokemon.txt', import.meta.url), 'utf8');
    const names = [...new Set(list.split(/\r?\n/).map(line => line.trim()).filter(Boolean))];
    let selected = values.all ? names : names.slice(0, limit);
    if (values.pokemon !== undefined) {
      selected = [...new Set(values.pokemon.map(query => {
        const name = names.find(entry => normalize(entry) === normalize(query));
        if (!name) throw new Error(`El nombre "${query}" no está en pokemon.txt`);
        return name;
      }))];
    }
    await mkdir(output, { recursive: true });
    let saved = 0;
    let existing = 0;
    let failures = 0;
    for (const name of selected) {
      try {
        const result = await download(name);
        if (result === 'saved') saved++;
        else existing++;
      } catch (error) {
        failures++;
        console.error(`${name}: ${error.message}${error.cause?.code ? ` (${error.cause.code})` : ''}`);
        if ([403, 429, 503].includes(error.status) || error.cause?.code === 'ENOTFOUND') break;
      }
    }
    console.log(`Descargados: ${saved}. Ya presentes: ${existing}. Fallos: ${failures}. Pendientes: ${selected.length - saved - existing - failures}.`);
    if (failures) process.exitCode = 1;
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
