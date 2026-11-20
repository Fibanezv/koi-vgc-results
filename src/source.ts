import { fetchStandings, SourceError } from './pokedata.ts';
import type { Snapshot, Tournament } from './model.ts';

export type Reading = { snapshot: Snapshot; etag?: string; sourceUpdatedAt: string | null };
export type LoadStandings = (tournament: Tournament, etag?: string) => Promise<Reading | null>;
type Slot = {
  reading?: Reading; next: number; failures: number; flight?: Promise<Reading>; error?: unknown; used: number;
};

export class SharedSource {
  private readonly slots = new Map<string, Slot>();

  constructor(private readonly intervalMs: number, private readonly load: LoadStandings = fetchStandings) {}

  read(tournament: Tournament): Promise<Reading> {
    const now = Date.now();
    for (const [key, slot] of this.slots) {
      if (!slot.flight && now > slot.next && now - slot.used > 3_600_000) this.slots.delete(key);
    }
    const key = `${tournament.id}:${tournament.division}`;
    const slot = this.slots.get(key) ?? { failures: 0, next: 0, used: now };
    this.slots.set(key, slot);
    slot.used = now;
    if (slot.flight) return slot.flight;
    if (now < slot.next) {
      return slot.error ? Promise.reject(slot.error) : Promise.resolve(slot.reading!);
    }
    slot.flight = this.load(tournament, slot.reading?.etag).then(reading => {
      if (reading) {
        const previous = Date.parse(slot.reading?.sourceUpdatedAt ?? '');
        const incoming = Date.parse(reading.sourceUpdatedAt ?? '');
        if (incoming < previous) throw new SourceError('PokéData devolvió una lectura anterior a la última válida.');
        slot.reading = reading;
      }
      if (!slot.reading) throw new SourceError('PokéData aún no ha publicado la clasificación.');
      if (!reading) slot.reading = { ...slot.reading };
      slot.failures = 0;
      slot.error = undefined;
      slot.next = Date.now() + this.intervalMs;
      return slot.reading;
    }).catch((error: unknown) => {
      slot.failures++;
      slot.error = error;
      slot.next = Date.now() + Math.max(error instanceof SourceError ? error.retryAfter : 0,
        Math.min(900_000, this.intervalMs * 2 ** Math.min(slot.failures, 8)));
      throw error;
    }).finally(() => { slot.flight = undefined; });
    return slot.flight;
  }
}
