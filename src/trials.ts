import type { Config, Notice, Outcome, OverlayState, Scenario } from './model.ts';
import { emptyOverlay } from './state.ts';
import { menuSoundTypes, noticeTypes } from './sounds.ts';

export const scenarios: Scenario[] = [...noticeTypes, 'double'];
export const trialPresets = [...scenarios, ...menuSoundTypes, 'marcador-mostrar', 'marcador-ocultar', 'conexion'] as const;
export type TrialPreset = typeof trialPresets[number];

export function simulateTrial(scenario: Scenario, config: Config | null = null) {
  const round = 4;
  const cards = [1, 2].map((id, index) => {
    const outcome: Outcome = index === 1 ? scenario === 'double' ? 'loss' : 'pending'
      : scenario === 'double' ? 'win' : scenario === 'pairing' ? 'pending' : scenario === 'correction' ? 'tie' : scenario;
    const selection = config?.players[index] ?? { id: -id, name: `Jugador ${id}`, alias: '', country: '' };
    return { selection, missing: false, dropped: false, record: outcome === 'win' ? '4–0–0' : outcome === 'loss'
      ? '3–1–0' : outcome === 'tie' ? '3–0–1' : '3–0–0',
      match: { round, outcome, table: index + 18, opponent: { id: id + 10, name: `Rival ${id}`, country: '' }, score: null } };
  });
  const state: OverlayState = { ...emptyOverlay, title: 'Torneo simulado', round, cards, simulation: true,
    duration: config?.duration ?? emptyOverlay.duration, sound: config?.sound ?? emptyOverlay.sound, color: config?.color ?? emptyOverlay.color };
  const notices: Notice[] = cards.slice(0, scenario === 'double' ? 2 : 1).map(card => ({
    id: globalThis.crypto.randomUUID(), round, names: [card.selection.alias || card.selection.name],
    kind: scenario === 'pairing' ? 'pairing' : scenario === 'correction' ? 'correction' : 'result',
    outcome: card.match.outcome, opponent: card.match.opponent.name, table: card.match.table, record: card.record, score: null,
  }));
  return { state, notices };
}
