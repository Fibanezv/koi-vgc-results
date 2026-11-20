export const positions = ['top-left', 'top-center', 'top-right', 'middle-left', 'middle-center', 'middle-right', 'bottom-left', 'bottom-center', 'bottom-right'] as const;
export const entrances = ['bottom', 'top', 'left', 'right', 'fade', 'zoom', 'reveal', 'none'] as const;
export const scoreboardStyles = ['koi', 'retro'] as const;
export const alertStyles = ['match', ...scoreboardStyles] as const;
export const alertLayouts = ['horizontal', 'card', 'banner'] as const;
export const alertEffects = ['none', 'glow', 'sweep'] as const;
export const alertExits = ['match', 'fade', 'bottom', 'top', 'left', 'right', 'zoom', 'none'] as const;
export const scoreboardFieldKeys = ['logo', 'avatar', 'pokemon', 'name', 'outcome', 'opponent', 'table', 'record', 'tournament', 'round', 'reverse'] as const;
export type ScoreboardFields = Record<typeof scoreboardFieldKeys[number], boolean>;
export type PositionOffset = { x: number; y: number };
export type ScoreboardMotion = {
  entrance: typeof entrances[number]; exit: typeof alertExits[number]; effect: typeof alertEffects[number];
  entranceMs: number; exitMs: number;
};
export type Appearance = {
  scoreboard: boolean;
  alerts: boolean;
  hideScoreboardDuringAlert: boolean;
  scoreboardPosition: typeof positions[number];
  alertPosition: typeof positions[number];
  scoreboardOffset: PositionOffset;
  alertOffset: PositionOffset;
  marginX: number;
  marginY: number;
  scoreboardOpacity: number;
  alertOpacity: number;
  scoreboardSize: number;
  scoreboardStyle: typeof scoreboardStyles[number];
  scoreboardFields: ScoreboardFields;
  scoreboardMotion: ScoreboardMotion;
  alertSize: number;
  alertStyle: typeof alertStyles[number];
  alertLayout: typeof alertLayouts[number];
  entrance: typeof entrances[number];
  alertExit: typeof alertExits[number];
  alertEffect: typeof alertEffects[number];
  entranceMs: number;
  exitMs: number;
  alertGapMs: number;
  opponent: boolean;
  table: boolean;
  record: boolean;
  duration: number;
  sound: boolean;
  color: string;
};

export const defaultAppearance: Appearance = {
  scoreboard: true, alerts: true, scoreboardPosition: 'bottom-left', alertPosition: 'bottom-left',
  scoreboardOffset: { x: 0, y: 0 }, alertOffset: { x: 0, y: 0 },
  marginX: 3.5, marginY: 4, scoreboardOpacity: 100, alertOpacity: 100,
  hideScoreboardDuringAlert: false,
  scoreboardSize: 100, alertSize: 100, entrance: 'bottom', opponent: true, table: true, record: true,
  scoreboardStyle: 'koi',
  scoreboardMotion: { entrance: 'none', exit: 'match', effect: 'none', entranceMs: 280, exitMs: 220 },
  alertStyle: 'match', alertLayout: 'horizontal', alertEffect: 'none', alertExit: 'match',
  entranceMs: 280, exitMs: 220, alertGapMs: 180,
  scoreboardFields: { logo: true, avatar: true, pokemon: true, name: true, outcome: true,
    opponent: true, table: true, record: true, tournament: true, round: true, reverse: false },
  duration: 5, sound: true, color: '#83c8ff',
};

export function sharesPosition(settings: Pick<Appearance, 'scoreboardPosition' | 'alertPosition' | 'scoreboardOffset' | 'alertOffset'>) {
  return settings.scoreboardPosition === settings.alertPosition
    && settings.scoreboardOffset.x === settings.alertOffset.x && settings.scoreboardOffset.y === settings.alertOffset.y;
}

export function resolveAppearance(saved?: Partial<Appearance>): Appearance {
  return {
    ...defaultAppearance, ...saved,
    scoreboardFields: { ...defaultAppearance.scoreboardFields,
      opponent: saved?.opponent ?? true, table: saved?.table ?? true, record: saved?.record ?? true,
      ...saved?.scoreboardFields },
  };
}

export function validateAppearance(value: unknown, previous: Appearance = defaultAppearance): Appearance {
  const input = value as Appearance | null;
  const size = (n: number) => Number.isInteger(n) && n >= 60 && n <= 150;
  const integer = (n: number | undefined, min: number, max: number) =>
    n === undefined || (Number.isInteger(n) && n >= min && n <= max);
  const margin = (n?: number) => n === undefined || (Number.isFinite(n) && n >= 0 && n <= 15);
  const offset = (value?: PositionOffset) => value === undefined || Boolean(value
    && [value.x, value.y].every(n => Number.isFinite(n) && Math.abs(n) <= 50));
  if (!input || typeof input !== 'object' || !positions.includes(input.scoreboardPosition)
      || !positions.includes(input.alertPosition) || !entrances.includes(input.entrance)
      || !offset(input.scoreboardOffset) || !offset(input.alertOffset)
      || !margin(input.marginX) || !margin(input.marginY)
      || !integer(input.scoreboardOpacity, 30, 100) || !integer(input.alertOpacity, 30, 100)
      || !size(input.scoreboardSize) || !size(input.alertSize)
      || !Number.isInteger(input.duration) || input.duration < 2 || input.duration > 15
      || typeof input.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(input.color)
      || !(['scoreboard', 'alerts', 'opponent', 'table', 'record', 'sound'] as const).every(key => typeof input[key] === 'boolean')
      || (input.scoreboardStyle !== undefined && !scoreboardStyles.includes(input.scoreboardStyle))
      || (input.alertStyle !== undefined && !alertStyles.includes(input.alertStyle))
      || (input.alertLayout !== undefined && !alertLayouts.includes(input.alertLayout))
      || (input.alertEffect !== undefined && !alertEffects.includes(input.alertEffect))
      || (input.alertExit !== undefined && !alertExits.includes(input.alertExit))
      || (input.hideScoreboardDuringAlert !== undefined && typeof input.hideScoreboardDuringAlert !== 'boolean')
      || !integer(input.entranceMs, 100, 1500) || !integer(input.exitMs, 100, 1500)
      || !integer(input.alertGapMs, 0, 3000)
      || (input.scoreboardMotion !== undefined && (!input.scoreboardMotion
        || !entrances.includes(input.scoreboardMotion.entrance) || !alertExits.includes(input.scoreboardMotion.exit)
        || !alertEffects.includes(input.scoreboardMotion.effect)
        || !Number.isInteger(input.scoreboardMotion.entranceMs) || !integer(input.scoreboardMotion.entranceMs, 100, 1500)
        || !Number.isInteger(input.scoreboardMotion.exitMs) || !integer(input.scoreboardMotion.exitMs, 100, 1500)))
      || (input.scoreboardFields !== undefined && (!input.scoreboardFields
        || !scoreboardFieldKeys.every(key => typeof input.scoreboardFields[key] === 'boolean')))) {
    throw new Error('Revisa las posiciones, márgenes, opacidades, tamaños y tiempos del overlay.');
  }
  return {
    ...(Object.fromEntries(Object.keys(defaultAppearance).map(key => [key, input[key as keyof Appearance]])) as Appearance),
    scoreboardStyle: input.scoreboardStyle ?? previous.scoreboardStyle,
    scoreboardMotion: input.scoreboardMotion ? {
      entrance: input.scoreboardMotion.entrance, exit: input.scoreboardMotion.exit, effect: input.scoreboardMotion.effect,
      entranceMs: input.scoreboardMotion.entranceMs, exitMs: input.scoreboardMotion.exitMs,
    } : previous.scoreboardMotion,
    scoreboardOffset: input.scoreboardOffset ? { x: input.scoreboardOffset.x, y: input.scoreboardOffset.y } : previous.scoreboardOffset,
    alertOffset: input.alertOffset ? { x: input.alertOffset.x, y: input.alertOffset.y } : previous.alertOffset,
    marginX: input.marginX ?? previous.marginX,
    marginY: input.marginY ?? previous.marginY,
    scoreboardOpacity: input.scoreboardOpacity ?? previous.scoreboardOpacity,
    alertOpacity: input.alertOpacity ?? previous.alertOpacity,
    hideScoreboardDuringAlert: input.hideScoreboardDuringAlert ?? previous.hideScoreboardDuringAlert,
    alertStyle: input.alertStyle ?? previous.alertStyle,
    alertLayout: input.alertLayout ?? previous.alertLayout,
    alertEffect: input.alertEffect ?? previous.alertEffect,
    alertExit: input.alertExit ?? previous.alertExit,
    entranceMs: input.entranceMs ?? previous.entranceMs,
    exitMs: input.exitMs ?? previous.exitMs,
    alertGapMs: input.alertGapMs ?? previous.alertGapMs,
    scoreboardFields: input.scoreboardFields ? Object.fromEntries(scoreboardFieldKeys.map(key => [key, input.scoreboardFields[key]])) as ScoreboardFields
      : previous.scoreboardFields,
  };
}
