import type { Config, Match, Notice, OverlayState, Outcome, Snapshot } from './model.ts';
import { defaultAppearance } from './appearance.ts';

export const emptyOverlay: OverlayState = {
  title: '', round: 0, cards: [], duration: defaultAppearance.duration, sound: defaultAppearance.sound, color: defaultAppearance.color, simulation: false,
};
export const outcomeLabel: Record<Outcome, string> = {
  win: 'Victoria', loss: 'Derrota', tie: 'Empate', bye: 'Pase libre', pending: 'Pendiente', unknown: 'Por confirmar',
};
export const scopeFor = (config: Config) => `${config.id}:${config.division}`;
const normalizedName = (name: string) => name.normalize('NFC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('es');
const final = (outcome: Outcome) => outcome !== 'pending' && outcome !== 'unknown';
const matchKey = (playerId: number, round: number) => `${playerId}:${round}`;
type Remembered = { fingerprint: string; outcome: Outcome; revision: number };
export type History = Record<string, Remembered>;

function fingerprint(match: Match): string {
  return JSON.stringify([match.opponent?.id ?? null, match.table, match.outcome, match.score]);
}

export function reconcile(config: Config, snapshot: Snapshot, previous: History | null) {
  const next: History = { ...previous };
  const notices: Notice[] = [];
  const crossed = new Map<string, Notice>();
  const byId = new Map(snapshot.players.map(player => [player.id, player]));
  const cards = config.players.map(selection => {
    const candidate = byId.get(selection.id);
    const player = candidate && normalizedName(candidate.name) === normalizedName(selection.name)
      && candidate.country === selection.country ? candidate : null;
    const matches = player?.matches ?? [];
    for (const match of matches) {
      const key = matchKey(selection.id, match.round);
      const old = next[key];
      const value = fingerprint(match);
      if (old?.fingerprint === value || (old && match.outcome === 'unknown')) continue;
      const revision = (old?.revision ?? 0) + 1;
      next[key] = { fingerprint: value, outcome: match.outcome, revision };
      if (!previous || match.outcome === 'unknown') continue;
      if (!old && match.round < snapshot.round && !final(match.outcome)) continue;
      const kind = old && final(old.outcome) ? 'correction' : final(match.outcome) ? 'result' : 'pairing';
      const notice: Notice = {
        id: `${scopeFor(config)}:${key}:${revision}`, kind,
        round: match.round, names: [selection.alias || selection.name], outcome: match.outcome,
        opponent: match.opponent?.name ?? null, table: match.table, record: player!.record, score: match.score,
      };
      if (match.opponent && config.players.some(other => other.id === match.opponent!.id)) {
        const ids = [selection.id, match.opponent.id].sort((a, b) => a - b);
        const shared = `${match.round}:${ids.join(':')}:${kind}`;
        const prior = crossed.get(shared);
        if (prior) {
          prior.names.push(notice.names[0]);
          if (notice.outcome === 'win') Object.assign(prior, { names: [...prior.names].reverse(), outcome: 'win', record: notice.record, score: notice.score });
          prior.opponent = null;
          continue;
        }
        crossed.set(shared, notice);
      }
      notices.push(notice);
    }
    return { selection, match: matches.find(match => match.round === snapshot.round) ?? null,
      record: player?.record ?? null, missing: !player, dropped: player?.dropped ?? false, matchHistory: matches };
  });
  const state: OverlayState = {
    title: snapshot.title, round: snapshot.round, cards,
    duration: config.duration, sound: config.sound, color: config.color, simulation: false,
  };
  return { state, next, notices: notices.sort((a, b) => a.round - b.round) };
}
