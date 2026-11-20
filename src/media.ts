import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { digest } from './store.ts';
import { categories } from './media-types.ts';
import type { Category, MediaCatalog } from './media-types.ts';

const imageTypes: Record<string, string> = { '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' };
const pokemonTypes: Record<string, string> = { ...imageTypes, '.webm': 'video/webm' };
const audioTypes: Record<string, string> = { '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav' };
const gifTypes: Record<string, string> = { '.gif': 'image/gif' };

export function assetLibrary(root: string, additional?: string) {
  const roots = additional ? [additional, path.join(root, 'media')] : [path.join(root, 'media')];
  function find(category: Category, name: unknown) {
    if (typeof name !== 'string' || !name || name.length > 180 || /[\\/:\u0000-\u001f]/.test(name) || name.startsWith('.')) return null;
    const types = { sounds: audioTypes, gifs: gifTypes, players: imageTypes, pokemon: pokemonTypes }[category];
    const mime = types[path.extname(name).toLowerCase()];
    if (!mime) return null;
    for (const base of roots) {
      try {
        const folder = path.join(base, category);
        if (!lstatSync(folder).isDirectory()) continue;
        const file = path.join(folder, name);
        const stat = lstatSync(file);
        if (!stat.isFile() || !stat.size || stat.size > 16 * 1024 * 1024) continue;
        const full = realpathSync(file);
        if (path.dirname(full) !== realpathSync(folder)) continue;
        return { full, mime, version: digest(`${category}:${name}:${stat.size}:${stat.mtimeMs}`).slice(0, 16) };
      } catch {
        continue;
      }
    }
    return null;
  }
  function list() {
    return Object.fromEntries(categories.map(category => {
      const names = new Set<string>();
      for (const base of roots) {
        try {
          for (const file of readdirSync(path.join(base, category), { withFileTypes: true })) {
            if (file.isFile() && find(category, file.name)) names.add(file.name);
          }
        } catch {}
      }
      return [category, [...names].sort((a, b) => a.localeCompare(b, 'es'))];
    })) as MediaCatalog;
  }
  return { find, list };
}
