import { divisions } from './model.ts';
import type { Division, Outcome, Snapshot, Tournament } from './model.ts';

const origin = 'https://www.pokedata.ovh';

export function tournamentFrom(input: string, defaultDivision: Division): Tournament {
  let url: URL;
  try { url = new URL(input.trim()); } catch { throw new Error('Pega un enlace de clasificación de PokéData.'); }
  const route = /^\/standings2(?:\/([0-9]{1,12})(?:\/(Masters|Senior|Junior))?)?\/?$/.exec(url.pathname);
  const id = route && (route[1] || url.searchParams.get('id'));
  const division = route?.[2] || url.searchParams.get('division') || defaultDivision;
  if (url.protocol !== 'https:' || !['pokedata.ovh', 'www.pokedata.ovh'].includes(url.host)
      || url.username || url.password || !id || !/^\d{1,12}$/.test(id) || !divisions.includes(division as Division)) {
    throw new Error('Usa el enlace de un torneo de PokéData y elige una división válida.');
  }
  return { id, division: division as Division };
}

export function exportUrl(tournament: Tournament): string {
  return `${origin}/standings2/standings/${tournament.id}_${tournament.division}.json`;
}

type RawPlayer = { i: number; n: string; c: string; s?: number[]; d?: number | null; r?: unknown[] };
type RawData = { tournament?: { title?: string }; standings?: { division?: string; players?: RawPlayer[] } };
const outcomes: Record<number, Outcome> = { [-1]: 'pending', 0: 'loss', 1: 'tie', 3: 'win' };

export function normalize(payload: unknown, division: Division): Snapshot {
  const raw = payload as RawData | null;
  const title = raw?.tournament?.title;
  const roster = raw?.standings?.players;
  if (typeof title !== 'string' || raw?.standings?.division !== division || !Array.isArray(roster)) {
    throw new Error('PokéData devolvió un formato de clasificación inesperado.');
  }
  const entries = new Map<number, { id: number; name: string; country: string }>();
  for (const player of roster) {
    if (!player || !Number.isSafeInteger(player.i) || typeof player.n !== 'string' || !player.n.trim()
        || entries.has(player.i) || (player.r != null && !Array.isArray(player.r))) {
      throw new Error('La clasificación contiene una identidad o un historial incompletos.');
    }
    entries.set(player.i, { id: player.i, name: player.n, country: typeof player.c === 'string' ? player.c : '' });
  }
  let round = 0;
  const players = roster.map(player => {
    const matches = (player.r ?? []).flatMap((tuple, index) => {
      if (tuple == null) return [];
      if (!Array.isArray(tuple) || tuple.length < 3 || !Number.isInteger(tuple[1])) {
        throw new Error('PokéData cambió el formato de un cruce.');
      }
      const [opponentId, code, tableId] = tuple;
      const outcome = opponentId === -1 && code === 3 ? 'bye'
        : opponentId == null && tableId == null && code === 0 ? 'unknown' : outcomes[code] ?? 'unknown';
      round = Math.max(round, index + 1);
      return [{ round: index + 1, outcome, score: null, table: Number.isInteger(tableId) && tableId > 0 ? tableId : null,
        opponent: entries.get(opponentId) ?? null }];
    });
    const record = Array.isArray(player.s) && player.s.length === 3 && player.s.every(n => Number.isInteger(n) && n >= 0)
      ? player.s.join('–') : null;
    return { ...entries.get(player.i)!, record, matches, dropped: typeof player.d === 'number' && player.d > 0 };
  });
  return { title, round, players };
}

export class SourceError extends Error {
  constructor(message: string, readonly retryAfter = 0) { super(message); }
}

export async function fetchStandings(tournament: Tournament, etag?: string, signal?: AbortSignal) {
  const timeout = AbortSignal.timeout(12_000);
  let response: Response;
  try {
    response = await fetch(exportUrl(tournament), {
      headers: etag ? { 'If-None-Match': etag } : {},
      redirect: 'error',
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch {
    throw new SourceError('No se pudo conectar con PokéData. Revisa tu conexión a Internet.');
  }
  if (response.status === 304) return null;
  if (response.status === 404) throw new SourceError('PokéData aún no ofrece la clasificación para este torneo y división.');
  if (!response.ok) {
    const retry = response.headers.get('retry-after');
    const delay = retry && /^\d+$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry ?? '') - Date.now();
    throw new SourceError(`PokéData respondió con un error HTTP ${response.status}.`, Math.max(0, delay || 0));
  }
  if (!response.headers.get('content-type')?.includes('application/json')) {
    throw new SourceError('PokéData respondió con un contenido distinto de la clasificación JSON.');
  }
  return {
    snapshot: normalize(await response.json(), tournament.division),
    etag: response.headers.get('etag') ?? undefined,
    sourceUpdatedAt: response.headers.get('last-modified'),
  };
}
