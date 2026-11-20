import type { Notice, ScoreMenu } from './model.ts';

export const noticeTypes = ['win', 'loss', 'tie', 'bye', 'pairing', 'correction'] as const;
export type NoticeType = typeof noticeTypes[number];
export const noticeNames: Record<NoticeType, string> = {
  win: 'Victoria', loss: 'Derrota', tie: 'Empate', bye: 'Pase libre', pairing: 'Nuevo cruce', correction: 'Corrección',
};
export const tones = {
  classic: { label: 'Clásico', notes: [588, 784] },
  rise: { label: 'Ascendente', notes: [523, 659, 880] },
  drop: { label: 'Descendente', notes: [659, 523, 392] },
  soft: { label: 'Suave', notes: [440, 523] },
  pulse: { label: 'Pulso', notes: [740, 740, 740] },
  mute: { label: 'Sin sonido', notes: [] },
};
export type Tone = keyof typeof tones;
export const menuSoundTypes = ['team', 'team-close', 'history', 'history-close'] as const;
export type MenuSoundType = typeof menuSoundTypes[number];
export type SoundEvent = NoticeType | MenuSoundType;
export const soundEvents = [...noticeTypes, ...menuSoundTypes];
export const soundNames: Record<SoundEvent, string> = { ...noticeNames, team: 'Abrir equipo Pokémon', 'team-close': 'Cerrar equipo Pokémon',
  history: 'Abrir historial', 'history-close': 'Cerrar historial' };
export function isMenuSound(event: unknown): event is MenuSoundType {
  return menuSoundTypes.some(type => type === event);
}
export function menuSoundEvent(previous: ScoreMenu | null, next: ScoreMenu | null): MenuSoundType | undefined {
  if (next?.id === previous?.id && next?.kind === previous?.kind) return;
  return next?.kind ?? (previous ? previous.kind === 'team' ? 'team-close' : 'history-close' : undefined);
}
export type SoundChoice = `tone:${Tone}` | `file:${string}`;
export type SoundMix = { alerts: boolean; menus: boolean; alertsVolume: number; menusVolume: number };
export const defaultSoundMix: SoundMix = { alerts: true, menus: true, alertsVolume: 100, menusVolume: 100 };
export type SoundSettings = { volume: number; byType: Record<NoticeType, Tone>; files?: Partial<Record<NoticeType, string>>;
  choices?: Partial<Record<SoundEvent, SoundChoice[]>>; mix?: SoundMix };
export const defaultSounds: SoundSettings = {
  volume: 55, byType: { win: 'classic', loss: 'classic', tie: 'classic', bye: 'classic', pairing: 'classic', correction: 'classic' },
};

function isSoundChoice(value: unknown): value is SoundChoice {
  return typeof value === 'string' && (value.startsWith('tone:') && value !== 'tone:mute' && Object.hasOwn(tones, value.slice(5))
    || value.startsWith('file:') && value.length > 5);
}
export function soundVolume(volume: number, mix: SoundMix, event: SoundEvent, audition = false) {
  const group = isMenuSound(event) ? 'menus' : 'alerts';
  return audition || mix[group] ? Math.round(volume * mix[group === 'menus' ? 'menusVolume' : 'alertsVolume'] / 100) : 0;
}

export function soundsFor(settings: SoundSettings, event: SoundEvent): SoundChoice[] {
  const choices = settings.choices?.[event];
  if (choices) return choices;
  if (isMenuSound(event)) return [];
  const file = settings.files?.[event];
  return file ? [`file:${file}`] : settings.byType[event] === 'mute' ? [] : [`tone:${settings.byType[event]}`];
}

export function soundFiles(settings: SoundSettings) {
  return soundEvents.flatMap(event => soundsFor(settings, event)
    .filter(choice => choice.startsWith('file:')).map(choice => choice.slice(5)));
}

export function pickSound(choices: SoundChoice[], previous?: SoundChoice, random = Math.random) {
  const available = choices.length > 1 ? choices.filter(choice => choice !== previous) : choices;
  return available[Math.floor(random() * available.length)];
}

export function noticeType(notice: Notice): NoticeType | undefined {
  if (notice.kind !== 'result') return notice.kind;
  return notice.outcome === 'pending' || notice.outcome === 'unknown' ? undefined : notice.outcome;
}

export function validateSounds(value: unknown): SoundSettings {
  const input = value as SoundSettings | null;
  const volume = (n: number) => Number.isInteger(n) && n >= 0 && n <= 100;
  if (!input || !volume(input.volume)
      || !input.byType || !noticeTypes.every(type => Object.hasOwn(tones, input.byType[type]))) {
    throw new Error('Elige un volumen entre 0 y 100 y un tono válido para cada aviso.');
  }
  if (input.files !== undefined && (!input.files || typeof input.files !== 'object' || Array.isArray(input.files)
      || !Object.entries(input.files).every(([kind, file]) => noticeTypes.includes(kind as NoticeType) && typeof file === 'string'))) {
    throw new Error('Elige archivos de sonido del catálogo.');
  }
  if (input.choices !== undefined && (!input.choices || typeof input.choices !== 'object' || Array.isArray(input.choices)
      || !Object.entries(input.choices).every(([event, choices]) =>
        soundEvents.includes(event as SoundEvent) && Array.isArray(choices) && choices.every(isSoundChoice)))) {
    throw new Error('Elige tonos o archivos de sonido válidos para cada evento.');
  }
  const mix = input.mix;
  if (mix !== undefined && (!mix || typeof mix.alerts !== 'boolean' || typeof mix.menus !== 'boolean'
      || !volume(mix.alertsVolume) || !volume(mix.menusVolume))) {
    throw new Error('Revisa el volumen y la activación de los grupos de sonido.');
  }
  return { volume: input.volume, byType: Object.fromEntries(noticeTypes.map(type => [type, input.byType[type]])) as SoundSettings['byType'],
    ...(input.files && { files: input.files }),
    ...(mix && { mix: { alerts: mix.alerts, menus: mix.menus, alertsVolume: mix.alertsVolume, menusVolume: mix.menusVolume } }),
    ...(input.choices && { choices: Object.fromEntries(Object.entries(input.choices).map(([event, choices]) => [event, [...new Set(choices)]])) }) };
}

export function playTone(audio: AudioContext, tone: Tone, volume: number) {
  if (!volume) return;
  const playing = new Set<OscillatorNode>();
  const start = audio.currentTime;
  for (const [index, frequency] of tones[tone].notes.entries()) {
    const time = start + index * .09;
    const wave = audio.createOscillator();
    const gain = audio.createGain();
    wave.frequency.value = frequency;
    gain.gain.setValueAtTime(0.001, time);
    gain.gain.linearRampToValueAtTime(Math.max(.001, volume / 100 * .15), time + .018);
    gain.gain.exponentialRampToValueAtTime(.001, time + .17);
    wave.connect(gain).connect(audio.destination);
    playing.add(wave);
    wave.onended = () => { playing.delete(wave); wave.disconnect(); gain.disconnect(); };
    wave.start(time);
    wave.stop(time + .18);
  }
  return () => { for (const wave of playing) wave.stop(); playing.clear(); };
}
