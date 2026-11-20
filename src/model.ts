import type { Appearance } from './appearance.ts';
import type { NoticeType, SoundSettings } from './sounds.ts';
import type { MediaSelections, NoticeGifs } from './media-types.ts';

export const divisions = ['Masters', 'Senior', 'Junior'] as const;
export const teamSlots = [1, 2, 3, 4, 5, 6] as const;
export type Division = typeof divisions[number];
export type Outcome = 'pending' | 'win' | 'loss' | 'tie' | 'bye' | 'unknown';
export type Entry = { id: number; name: string; country: string };
export type Selection = Entry & { alias: string };
export type Tournament = { id: string; division: Division };
export type Config = Tournament & { title: string; players: Selection[]; duration: number; sound: boolean; color: string };
export type Match = { round: number; opponent: Entry | null; table: number | null; outcome: Outcome; score: string | null };
export type Player = Entry & { record: string | null; matches: Match[]; dropped: boolean };
export type Snapshot = { title: string; round: number; players: Player[] };
export type Card = { selection: Selection; record: string | null; match: Match | null; missing: boolean; dropped: boolean;
  sprite?: string; pokemon?: string; team?: (string | null)[]; teamVideoSlots?: number[]; matchHistory?: Match[]; historyVersion?: string };
export type ScoreMenu = { id: number; kind: 'team' | 'history' };
export type ProgramMenu = { revision: number; selected: ScoreMenu | null };
export type OverlayState = { title: string; round: number; cards: Card[]; duration: number; sound: boolean; color: string; simulation: boolean; appearance?: Appearance;
  sounds?: SoundSettings; gifs?: NoticeGifs; programMenu?: ProgramMenu };
export type Notice = {
  id: string; round: number; names: string[]; kind: 'pairing' | 'result' | 'correction';
  outcome: Outcome; opponent: string | null; table: number | null; record: string | null; score: string | null;
};
export type Status = {
  phase: 'idle' | 'syncing' | 'live' | 'waiting' | 'error' | 'paused';
  message: string; checkedAt: string | null; successAt: string | null; sourceUpdatedAt: string | null;
};
export type Setup = { title: string; entries: Entry[]; tournament: Tournament };
export type PanelState = { config: Config | null; overlay: OverlayState; appearance: Appearance; status: Status; origin: string; url: string; previewUrl: string; activeUntil: number | null; media: MediaSelections };
export type SpritePreview = {
  state: OverlayState; notices: Notice[]; players: MediaSelections['players']; legacySource: string;
};
export type Scenario = NoticeType | 'double';
