import type { NoticeType } from './sounds.ts';

export const categories = ['players', 'pokemon', 'gifs', 'sounds'] as const;
export type Category = typeof categories[number];
export type MediaCatalog = Record<Category, string[]>;
export type NoticeGifs = Partial<Record<NoticeType, string[]>>;
export const defaultNoticeGifs: NoticeGifs = {
  win: ['win_01.gif', 'win_02.gif'],
  loss: ['lose_01.gif', 'lose_02.gif'],
  tie: ['draw_01.gif'],
};
export type MediaSelections = {
  players: Record<string, { avatar?: string; team: (string | null)[] }>;
  gifs: NoticeGifs;
};

export function pickNoticeGif(files: string[], previous?: string, random = Math.random): string | undefined {
  if (!files.length) return undefined;
  const choices = files.length > 1 ? files.filter(file => file !== previous) : files;
  return choices[Math.floor(random() * choices.length)];
}
