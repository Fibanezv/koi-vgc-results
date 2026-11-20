import { createHash, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { Config, Notice, OverlayState, ProgramMenu, Status } from './model.ts';
import type { History } from './state.ts';
import { emptyOverlay } from './state.ts';
import type { Appearance } from './appearance.ts';
import type { SoundSettings } from './sounds.ts';
import type { NoticeGifs } from './media-types.ts';

export const token = () => randomBytes(32).toString('base64url');
export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export const idleStatus: Status = { phase: 'idle', message: 'Carga un torneo para empezar.', checkedAt: null, successAt: null, sourceUpdatedAt: null };
export type Sprite = { version: string; mime: string; data: string } | { file: string };
export type Stream = {
  owner: string; live: string | null; preview: string | null; config: Config | null; history: History | null;
  overlayOrigin?: string;
  overlay: OverlayState; status: Status; activeUntil: number | null; generation?: string; appearance?: Appearance;
  sprites?: Record<string, Sprite>;
  sounds?: SoundSettings;
  programMenu?: ProgramMenu;
  noticeGifs?: NoticeGifs;
};

export class Store {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      pragma journal_mode = wal;
      pragma busy_timeout = 3000;
      create table if not exists streams(owner text primary key, live text unique, preview text unique, data text not null);
      create table if not exists sessions(hash text primary key, owner text not null, expires integer not null, credential text);
      create table if not exists events(owner text not null, id text not null, created integer not null, primary key(owner,id));
      pragma user_version = 1;
    `);
    if (!this.db.prepare('pragma table_info(sessions)').all().some(column => column.name === 'credential')) {
      this.db.exec('alter table sessions add column credential text');
    }
  }

  get(owner: string): Stream {
    const row = this.db.prepare('select data from streams where owner=?').get(owner);
    if (row) return JSON.parse(String(row.data)) as Stream;
    const stream = { owner, live: token(), preview: token(), config: null, history: null, overlay: emptyOverlay, status: idleStatus, activeUntil: null };
    this.save(stream);
    return stream;
  }

  byLink(link: string): Stream | null {
    const row = this.db.prepare('select data from streams where live=? or preview=?').get(link, link);
    return row ? JSON.parse(String(row.data)) as Stream : null;
  }

  active(): Stream[] {
    return this.db.prepare("select data from streams where json_type(data,'$.activeUntil')='integer'").all()
      .map(row => JSON.parse(String(row.data)) as Stream);
  }

  save(stream: Stream, notices: Notice[] = []): Notice[] {
    this.db.exec('begin immediate');
    try {
      this.db.prepare('insert into streams values (?, ?, ?, ?) on conflict(owner) do update set live=excluded.live,preview=excluded.preview,data=excluded.data')
        .run(stream.owner, stream.live, stream.preview, JSON.stringify(stream));
      const insert = this.db.prepare('insert or ignore into events values (?, ?, ?)');
      const fresh = notices.filter(notice => insert.run(stream.owner, notice.id, Date.now()).changes === 1);
      this.db.exec('commit');
      return fresh;
    } catch (error) {
      this.db.exec('rollback');
      throw error;
    }
  }

  login(owner: string, expires: number, credential: string) {
    const session = token();
    this.db.prepare('insert into sessions values (?, ?, ?, ?)').run(digest(session), owner, expires, credential);
    return session;
  }

  session(session: string) {
    const row = this.db.prepare('select owner, credential from sessions where hash=? and expires>?').get(digest(session), Date.now());
    return typeof row?.owner === 'string' && typeof row.credential === 'string'
      ? { owner: row.owner, credential: row.credential } : null;
  }

  logout(session: string) { this.db.prepare('delete from sessions where hash=?').run(digest(session)); }

  cleanup() {
    this.db.prepare('delete from sessions where expires<=?').run(Date.now());
    this.db.prepare('delete from events where created<?').run(Date.now() - 30 * 86_400_000);
  }

  close() { this.db.close(); }
}
