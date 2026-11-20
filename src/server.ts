import express from 'express';
import type { Request, Response } from 'express';
import { timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { divisions, teamSlots } from './model.ts';
import type { Config, Division, Entry, Notice, OverlayState, PanelState, Scenario, ScoreMenu, Setup, Snapshot, Tournament } from './model.ts';
import { simulateTrial, scenarios, trialPresets } from './trials.ts';
import type { TrialPreset } from './trials.ts';
import { defaultAppearance, resolveAppearance, validateAppearance } from './appearance.ts';
import { defaultSounds, isMenuSound, noticeTypes, soundEvents, soundFiles, soundsFor, validateSounds } from './sounds.ts';
import type { NoticeType, SoundSettings } from './sounds.ts';
import { tournamentFrom } from './pokedata.ts';
import { reconcile, scopeFor } from './state.ts';
import { SharedSource } from './source.ts';
import type { LoadStandings } from './source.ts';
import { digest, idleStatus, Store, token } from './store.ts';
import type { Sprite, Stream } from './store.ts';
import { assetLibrary } from './media.ts';
import { categories, defaultNoticeGifs } from './media-types.ts';
import type { Category } from './media-types.ts';

const sessionLifetime = 7 * 86_400_000;
const liveLifetime = 12 * 3_600_000;
const linkPattern = /^[\w-]{43}$/;
const isoNow = () => new Date().toISOString();
const errorMessage = (error: unknown) => error instanceof Error ? error.message : 'Error desconocido.';
type Inspection = { setup: Setup; snapshot: Snapshot; at: number };
export type Options = { origin: string; dataPath: string; codes: Record<string, string>; root: string; mediaRoot?: string; intervalMs?: number; load?: LoadStandings; pagesOrigin?: string };

export function createService(options: Options) {
  const origin = new URL(options.origin).origin;
  const secure = origin.startsWith('https://');
  const site = express();
  site.disable('x-powered-by');
  if (secure) site.set('trust proxy', 1);
  const store = new Store(options.dataPath);
  store.cleanup();
  const source = new SharedSource(options.intervalMs ?? 60_000, options.load);
  const previews = new Map<string, Scenario>();
  const inspections = new Map<string, Inspection>();
  const subscribers = new Map<string, Set<Response>>();
  const activeWork = new Set<string>();
  const lastRead = new Map<string, unknown>();
  const attempts = new Map<string, { count: number; until: number }>();
  const credentials = Object.entries(options.codes).map(([owner, code]) => [owner, Buffer.from(digest(code), 'hex')] as const);
  const byOwner = new Map(credentials);
  const uiFiles = { root: path.join(options.root, 'ui') };
  const builtFiles = { root: path.join(options.root, 'build') };
  const library = assetLibrary(options.root, options.mediaRoot);

  function cookie(req: Request) {
    return req.headers.cookie?.split(';').map(piece => piece.trim()).find(piece => piece.startsWith('koi_session='))?.slice(12) ?? '';
  }
  function isPagesRequest(req: Request) {
    return Boolean(options.pagesOrigin && req.get('origin') === options.pagesOrigin);
  }
  function sessionToken(req: Request) {
    return isPagesRequest(req) ? req.get('authorization')?.match(/^Bearer ([A-Za-z0-9_-]+)$/)?.[1] ?? '' : cookie(req);
  }
  function operator(req: Request) {
    const value = sessionToken(req);
    const session = linkPattern.test(value) ? store.session(value) : null;
    const code = session && byOwner.get(session.owner);
    return session && code?.toString('hex') === session.credential ? session.owner : null;
  }
  function linkUrl(link: string | null, base: string) { return link ? `${base}/o/${link}` : ''; }
  function spriteKey(stream: Stream, id: number, kind: 'player' | 'pokemon' = 'player') {
    const key = `${scopeFor(stream.config!)}:${id}`;
    return kind === 'pokemon' ? `pokemon:${key}` : key;
  }
  function pokemonKey(stream: Stream, id: number, slot: number) {
    const key = spriteKey(stream, id, 'pokemon');
    return slot === 1 ? key : `${key}:${slot}`;
  }
  function spriteMedia(sprite: Sprite | undefined, category: Category) {
    return sprite && ('file' in sprite ? library.find(category, sprite.file) : sprite);
  }
  function spriteFile(sprite: Sprite | undefined) {
    return sprite && 'file' in sprite ? sprite.file : undefined;
  }
  function appearance(stream: Stream) {
    return resolveAppearance(stream.appearance ?? {
      color: defaultAppearance.color, sound: defaultAppearance.sound,
      duration: stream.config?.duration ?? defaultAppearance.duration });
  }
  function styled(stream: Stream, state: OverlayState = stream.overlay): OverlayState {
    const settings = appearance(stream);
    const cards = state.cards.map(({ matchHistory, ...card }) => {
      const id = card.selection.id;
      if (!stream.config?.players.some(player => player.id === id && player.name === card.selection.name)) return card;
      const teamMedia = teamSlots.map(slot => spriteMedia(stream.sprites?.[pokemonKey(stream, id, slot)], 'pokemon'));
      const team = teamMedia.map(asset => asset?.version ?? null);
      const teamVideoSlots = teamSlots.filter((_, index) => teamMedia[index]?.mime === 'video/webm');
      const savedHistory = matchHistory ?? stream.overlay.cards.find(card => card.selection.id === id)?.matchHistory;
      return { ...card, sprite: spriteMedia(stream.sprites?.[spriteKey(stream, id)], 'players')?.version,
        pokemon: team[0] ?? undefined, team, teamVideoSlots,
        historyVersion: savedHistory && digest(JSON.stringify(savedHistory)).slice(0, 12) };
    });
    const gifs = Object.fromEntries(Object.entries(selectedGifs(stream)).map(([type, files]) =>
      [type, files.filter(file => library.find('gifs', file))]));
    return { ...state, cards, gifs, sounds: stream.sounds ?? defaultSounds,
      ...(!state.simulation && { programMenu: stream.programMenu ?? { revision: 0, selected: null } }),
      appearance: settings, color: settings.color, sound: settings.sound, duration: settings.duration };
  }
  function selectedGifs(stream: Stream) {
    const defaults = Object.fromEntries(noticeTypes.map(type => [type,
      defaultNoticeGifs[type]?.filter(file => library.find('gifs', file)) ?? [],
    ]));
    return { ...defaults, ...stream.noticeGifs };
  }
  function previewState(stream: Stream) {
    return styled(stream, simulateTrial(previews.get(stream.preview!) ?? 'pairing', stream.config).state);
  }
  function setProgramMenu(stream: Stream, selected: ScoreMenu | null) {
    stream.programMenu = { revision: (stream.programMenu?.revision ?? 0) + 1, selected };
  }
  function playerMedia(stream: Stream) {
    return Object.fromEntries((stream.config?.players ?? []).map(({ id }) => [id, {
      avatar: spriteFile(stream.sprites?.[spriteKey(stream, id)]),
      team: teamSlots.map(slot => spriteFile(stream.sprites?.[pokemonKey(stream, id, slot)]) ?? null),
    }]));
  }
  function panel(stream: Stream): PanelState {
    const base = stream.overlayOrigin ?? origin;
    return { config: stream.config, overlay: styled(stream), appearance: appearance(stream), status: stream.status, activeUntil: stream.activeUntil,
      origin: base, url: linkUrl(stream.live, base), previewUrl: linkUrl(stream.preview, base), media: { players: playerMedia(stream), gifs: selectedGifs(stream) } };
  }
  type TrialControl = { test: TrialPreset } | { stop: true };
  function packet(state: OverlayState, notices: Notice[], control?: TrialControl) {
    return `event: state\ndata: ${JSON.stringify({ state, notices, control })}\n\n`;
  }
  function broadcast(link: string | null, state: OverlayState, notices: Notice[] = [], control?: TrialControl) {
    if (!link) return;
    for (const res of subscribers.get(link) ?? []) {
      if (res.writableLength > 128_000) res.end();
      else res.write(packet(state, notices, control));
    }
  }
  function revoke(link: string | null) {
    if (!link) return;
    for (const res of subscribers.get(link) ?? []) {
      res.write('event: revoked\ndata: {}\n\n');
      res.end();
    }
    subscribers.delete(link);
    previews.delete(link);
  }
  function sync(stream: Stream, snapshot: Snapshot, announce: boolean) {
    const result = reconcile(stream.config!, snapshot, announce ? stream.history : null);
    stream.overlay = result.state;
    stream.history = result.next;
    return result.notices.map(notice => ({ ...notice, id: `${stream.generation}:${notice.id}` }));
  }
  async function poll(owner: string) {
    if (activeWork.has(owner)) return;
    const start = store.get(owner);
    if (!start.config || !start.activeUntil) return;
    if (start.activeUntil <= Date.now()) {
      lastRead.delete(owner);
      start.activeUntil = null;
      start.status = { ...start.status, phase: 'paused', message: 'La sesión de seguimiento ha caducado.' };
      store.save(start);
      return;
    }
    activeWork.add(owner);
    const checkedAt = isoNow();
    const current = () => {
      const stream = store.get(owner);
      return stream.activeUntil === start.activeUntil && stream.generation === start.generation ? stream : null;
    };
    try {
      const reading = await source.read(start.config);
      const stream = current();
      if (!stream) return;
      if (lastRead.get(owner) === reading && stream.status.phase !== 'syncing') return;
      const previousUpdate = Date.parse(stream.status.sourceUpdatedAt ?? '');
      if (Date.parse(reading.sourceUpdatedAt ?? '') < previousUpdate) throw new Error('PokéData devolvió una lectura anterior a la última válida.');
      const notices = sync(stream, reading.snapshot, true);
      const missing = stream.overlay.cards.some(card => card.missing);
      stream.status = { phase: stream.overlay.round ? 'live' : 'waiting', checkedAt, successAt: isoNow(),
        sourceUpdatedAt: reading.sourceUpdatedAt ?? stream.status.sourceUpdatedAt,
        message: missing ? 'PokéData dejó de mostrar un jugador con la identidad seleccionada. Revisa la configuración.'
          : stream.overlay.round ? 'Siguiendo los resultados de PokéData.' : 'Esperando la primera ronda.' };
      const fresh = store.save(stream, notices);
      lastRead.set(owner, reading);
      broadcast(stream.live, styled(stream), appearance(stream).alerts ? fresh : []);
    } catch (error) {
      const stream = current();
      if (stream && (lastRead.get(owner) !== error || stream.status.phase !== 'error')) {
        stream.status = { ...stream.status, phase: 'error', checkedAt,
          message: `${errorMessage(error)} Se conserva el último marcador y se volverá a intentar.` };
        store.save(stream);
        lastRead.set(owner, error);
      }
    } finally { activeWork.delete(owner); }
  }

  site.use((req, res, next) => {
    const embeddable = req.path === '/api/panel/sprite-preview' || req.path === '/api/panel/live-view';
    res.set({
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': `default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors ${embeddable ? "'self'" : "'none'"}; form-action 'self'`,
    });
    if (secure) res.set('Strict-Transport-Security', 'max-age=15552000');
    const apiPath = /^\/api\/(?:login$|logout$|panel(?:\/|$))/.test(req.path);
    const overlayPath = /^\/o\/[^/]+\//.test(req.path);
    if (apiPath || overlayPath) res.vary('Origin');
    const pages = isPagesRequest(req) && (apiPath || overlayPath);
    if (pages) {
      res.set('Access-Control-Allow-Origin', options.pagesOrigin!);
      if (req.method === 'OPTIONS') {
        res.set('Access-Control-Allow-Methods', apiPath ? 'GET, HEAD, POST' : 'GET, HEAD');
        res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
        res.sendStatus(204);
        return;
      }
    }
    if (req.method === 'POST' && req.get('origin') !== origin && !(apiPath && pages)) { res.sendStatus(403); return; }
    next();
  });
  site.use(express.json({ limit: '12kb' }));
  site.get('/healthz', (_req, res) => { res.json({ ok: true }); });
  site.get('/', (_req, res) => { res.sendFile('index.html', uiFiles); });
  site.get('/panel', (_req, res) => { res.sendFile('panel.html', uiFiles); });
  site.get('/koi-logo.jpg', (_req, res) => { res.sendFile('koi-logo.jpg', uiFiles); });
  for (const css of ['panel.css', 'overlay.css']) site.get('/' + css, (_req, res) => { res.sendFile(css, uiFiles); });
  for (const js of ['panel.js', 'overlay.js']) site.get('/' + js, (_req, res) => { res.sendFile(js, builtFiles); });

  site.post('/api/login', (req, res) => {
    const key = req.ip ?? 'local';
    const now = Date.now();
    for (const [ip, attempt] of attempts) if (attempt.until <= now) attempts.delete(ip);
    const entry = attempts.get(key) ?? { count: 0, until: now + 600_000 };
    if (entry.count >= 8 || attempts.size > 4000) {
      res.set('Retry-After', '600').status(429).json({ error: 'Demasiados intentos. Espera unos minutos.' });
      return;
    }
    const code = req.body?.code;
    const hash = Buffer.from(digest(typeof code === 'string' && code.length <= 256 ? code.trim() : ''), 'hex');
    const match = credentials.find(([, saved]) => timingSafeEqual(hash, saved));
    if (!match) {
      entry.count++;
      attempts.set(key, entry);
      res.status(401).json({ error: 'El código de acceso no es válido.' });
      return;
    }
    attempts.delete(key);
    const prior = sessionToken(req);
    if (linkPattern.test(prior)) store.logout(prior);
    const access = store.login(match[0], now + sessionLifetime, match[1].toString('hex'));
    if (isPagesRequest(req)) { res.json({ token: access }); return; }
    res.cookie('koi_session', access, { secure, httpOnly: true, sameSite: 'strict', path: '/', maxAge: sessionLifetime }).sendStatus(204);
  });
  site.post('/api/logout', (req, res) => {
    const value = sessionToken(req);
    if (linkPattern.test(value)) store.logout(value);
    if (isPagesRequest(req)) { res.sendStatus(204); return; }
    res.clearCookie('koi_session', { secure, httpOnly: true, sameSite: 'strict', path: '/' }).sendStatus(204);
  });

  const api = express.Router();
  api.use((req, res, next) => {
    const owner = operator(req);
    if (!owner) { res.status(401).json({ error: 'Inicia sesión para abrir el panel.' }); return; }
    res.locals.owner = owner;
    next();
  });
  const get = (res: Response) => store.get(res.locals.owner);
  const send = (res: Response, stream: Stream) => res.json(panel(stream));
  function serveAsset(res: Response, category: Category, name: string) {
    const asset = library.find(category, name);
    if (!asset) { res.sendStatus(404); return; }
    res.type(asset.mime).sendFile(path.basename(asset.full), { root: path.dirname(asset.full) });
  }
  api.get('/', (_req, res) => { send(res, get(res)); });
  api.post('/overlay-origin', (req, res) => {
    const stream = get(res);
    const value = req.body?.origin;
    if (value === null) delete stream.overlayOrigin;
    else {
      if (typeof value !== 'string' || value.length > 300 || !/^https?:\/\//i.test(value.trim())) {
        throw new Error('Introduce una URL base que empiece por https:// o http://.');
      }
      let url: URL;
      try { url = new URL(value.trim()); } catch { throw new Error('Introduce una URL base válida.'); }
      const local = !secure && url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
      if (url.pathname !== '/' || url.search || url.hash || url.username || url.password
          || (url.protocol !== 'https:' && !local && url.origin !== origin)) {
        throw new Error('Usa un origen HTTPS sin ruta ni parámetros, o una URL local para desarrollo.');
      }
      stream.overlayOrigin = url.origin;
    }
    store.save(stream);
    send(res, stream);
  });
  api.get('/live-view', (_req, res) => { res.sendFile('overlay.html', uiFiles); });
  api.get('/live-view/source', (_req, res) => {
    const link = get(res).live;
    if (!link) { res.sendStatus(404); return; }
    res.json({ path: `/o/${link}` });
  });
  api.get('/sprite-preview', (_req, res) => { res.sendFile('overlay.html', uiFiles); });
  api.get('/sprite-preview/state', (req, res) => {
    const stream = get(res);
    const { gif, type, player, openTeam, soundPreview, appearance: draft } = req.query;
    const legacyLink = stream.preview ?? stream.live;
    const assets = { players: playerMedia(stream), legacySource: legacyLink ? `/o/${legacyLink}` : '' };
    const soundScenario = scenarios.find(value => value === soundPreview);
    if (gif !== undefined || soundScenario) {
      const scenario = soundScenario ?? noticeTypes.find(value => value === type);
      if (!scenario || (gif !== undefined && (scenario === 'double' || typeof gif !== 'string' || !library.find('gifs', gif)))) {
        res.sendStatus(404); return;
      }
      const result = simulateTrial(scenario, stream.config);
      const state = styled(stream, result.state);
      let previewAppearance = appearance(stream);
      if (draft !== undefined) {
        if (typeof draft !== 'string' || draft.length > 2500) { res.sendStatus(400); return; }
        try { previewAppearance = validateAppearance(JSON.parse(draft), previewAppearance); }
        catch { res.sendStatus(400); return; }
      }
      res.json({ ...assets, state: { ...state, appearance: previewAppearance, color: previewAppearance.color,
        duration: previewAppearance.duration, sound: false, gifs: typeof gif === 'string' ? { [scenario]: [gif] } : state.gifs }, notices: result.notices });
      return;
    }
    const menuSound = isMenuSound(soundPreview) ? (soundPreview.startsWith('team') ? 'team' : 'history') : null;
    const state = styled(stream, stream.overlay.cards.length ? stream.overlay : simulateTrial('pairing', stream.config).state);
    const selected = menuSound ? state.cards[0]?.selection : stream.config?.players.find(entry => String(entry.id) === player);
    if (!selected) { res.sendStatus(404); return; }
    const menu = menuSound || openTeam === '1' ? { id: selected.id, kind: menuSound ?? 'team' } : null;
    res.json({ ...assets, state: { ...state, sound: false, appearance: { ...state.appearance, scoreboard: Boolean(menu || state.appearance?.scoreboard) },
      programMenu: { revision: 0, selected: menu } }, notices: [] });
  });
  api.get('/media', (_req, res) => { res.json(library.list()); });
  api.get('/media/:category/:name', (req, res) => {
    const category = categories.find(category => category === req.params.category);
    if (!category) { res.sendStatus(404); return; }
    serveAsset(res, category, String(req.params.name));
  });
  api.post('/inspect', async (req, res) => {
    const { url, division } = req.body ?? {};
    if (typeof url !== 'string' || !divisions.includes(division)) throw new Error('Indica el enlace del torneo y su división.');
    const tournament = tournamentFrom(url, division as Division);
    const { snapshot } = await source.read(tournament);
    const entries: Entry[] = snapshot.players.map(({ id, name, country }) => ({ id, name, country }))
      .sort((a, b) => a.name.localeCompare(b.name, 'es') || a.id - b.id);
    const setup = { title: snapshot.title, tournament, entries };
    inspections.set(res.locals.owner, { setup, snapshot, at: Date.now() });
    res.json(setup);
  });
  api.post('/setup', (req, res) => {
    const stream = get(res);
    if (stream.activeUntil && stream.activeUntil > Date.now()) throw new Error('Pausa el seguimiento para cambiar el torneo o los jugadores.');
    const inspection = inspections.get(stream.owner);
    const input = req.body as Partial<Config> | undefined;
    if (!input || !inspection || Date.now() - inspection.at > 3_600_000
        || input.id !== inspection.setup.tournament.id || input.division !== inspection.setup.tournament.division
        || !Number.isInteger(input.duration) || input.duration! < 2 || input.duration! > 15
        || typeof input.sound !== 'boolean' || typeof input.color !== 'string' || !/^#[a-f\d]{6}$/i.test(input.color)
        || !Array.isArray(input.players) || input.players.length < 1 || input.players.length > 2) {
      throw new Error('Vuelve a cargar el torneo y revisa los jugadores y los ajustes.');
    }
    const players = input.players.map(player => {
      const entry = inspection.setup.entries.find(item => item.id === player?.id);
      if (!entry || typeof player.alias !== 'string' || player.alias.trim().length > 32) throw new Error('Elige un jugador válido.');
      return { ...entry, alias: player.alias.trim() };
    });
    if (new Set(players.map(player => player.id)).size !== players.length) throw new Error('Elige dos jugadores distintos.');
    stream.config = { ...inspection.setup.tournament, title: inspection.setup.title, players,
      duration: input.duration!, sound: input.sound, color: input.color };
    if (stream.sprites) {
      const keys = new Set(players.flatMap(player => [spriteKey(stream, player.id), ...teamSlots.map(slot => pokemonKey(stream, player.id, slot))]));
      stream.sprites = Object.fromEntries(Object.entries(stream.sprites).filter(([key]) => key.startsWith('attack:') || keys.has(key)));
    }
    stream.generation = token();
    stream.activeUntil = null;
    setProgramMenu(stream, null);
    sync(stream, inspection.snapshot, false);
    stream.status = { ...idleStatus, phase: 'paused', message: 'Configuración guardada. Pulsa Iniciar seguimiento cuando estés listo.' };
    store.save(stream);
    broadcast(stream.live, styled(stream));
    broadcast(stream.preview, previewState(stream));
    send(res, stream);
  });
  api.post('/appearance', (req, res) => {
    const stream = get(res);
    const settings = validateAppearance(req.body?.appearance, appearance(stream));
    const aliases: unknown = req.body?.aliases;
    if (aliases !== undefined) {
      if (!Array.isArray(aliases) || !stream.config || aliases.length !== stream.config.players.length
          || !stream.config.players.every(player => aliases.some(item => item?.id === player.id
            && typeof item.alias === 'string' && item.alias.trim().length <= 32))) {
        throw new Error('Los jugadores han cambiado. Recarga el panel para editar sus alias.');
      }
      const players = stream.config.players.map(player => ({
        ...player, alias: (aliases.find(item => item.id === player.id).alias as string).trim(),
      }));
      stream.config = { ...stream.config, players };
      stream.overlay = { ...stream.overlay, cards: stream.overlay.cards.map(card => ({
        ...card, selection: players.find(player => player.id === card.selection.id) ?? card.selection,
      })) };
    }
    stream.appearance = settings;
    if (!settings.scoreboard && stream.programMenu?.selected) setProgramMenu(stream, null);
    store.save(stream);
    broadcast(stream.live, styled(stream));
    broadcast(stream.preview, previewState(stream));
    send(res, stream);
  });
  api.post('/scoreboard', (req, res) => {
    const stream = get(res);
    if (typeof req.body?.visible !== 'boolean') throw new Error('Indica si quieres mostrar el marcador.');
    stream.appearance = { ...appearance(stream), scoreboard: req.body.visible };
    if (!req.body.visible && stream.programMenu?.selected) setProgramMenu(stream, null);
    store.save(stream);
    broadcast(stream.live, styled(stream));
    broadcast(stream.preview, previewState(stream));
    send(res, stream);
  });
  api.post('/score-menu', (req, res) => {
    const stream = get(res);
    const selected = req.body?.selected;
    if (selected !== null) {
      if (!selected || (selected.kind !== 'team' && selected.kind !== 'history')
          || !stream.config?.players.some(player => player.id === selected.id)) {
        throw new Error('Elige el equipo o historial de un jugador seguido.');
      }
      if (!stream.live || !appearance(stream).scoreboard) throw new Error('Muestra el marcador con una URL de directo activa.');
    }
    setProgramMenu(stream, selected === null ? null : { id: selected.id, kind: selected.kind });
    store.save(stream);
    broadcast(stream.live, styled(stream));
    send(res, stream);
  });
  function saveSounds(res: Response, stream: Stream, sounds: SoundSettings, enabled: boolean) {
    stream.sounds = sounds;
    stream.appearance = { ...appearance(stream), sound: enabled };
    store.save(stream);
    broadcast(stream.live, styled(stream));
    broadcast(stream.preview, previewState(stream));
    send(res, stream);
  }
  function checkSoundFiles(files: string[]) {
    if (files.some(name => !library.find('sounds', name))) {
      throw new Error('Uno de los sonidos ya no está en la carpeta. Actualiza el catálogo y elige otro.');
    }
  }
  api.post('/sounds', (req, res) => {
    if (typeof req.body?.enabled !== 'boolean') throw new Error('Indica si quieres activar el sonido del overlay.');
    const sounds = validateSounds(req.body.sounds);
    checkSoundFiles(soundFiles(sounds));
    saveSounds(res, get(res), sounds, req.body.enabled);
  });
  api.post('/sounds/volume', (req, res) => {
    const stream = get(res);
    const { volume, enabled, mix } = req.body ?? {};
    if (typeof enabled !== 'boolean') throw new Error('Indica si quieres activar el sonido del overlay.');
    const sounds = validateSounds({ ...stream.sounds ?? defaultSounds, volume, ...(mix !== undefined && { mix }) });
    saveSounds(res, stream, sounds, enabled);
  });
  api.post('/sounds/:event', (req, res) => {
    const stream = get(res);
    const event = soundEvents.find(value => value === req.params.event);
    if (!event || !Array.isArray(req.body?.choices)) throw new Error('Elige un evento y sus sonidos.');
    const saved = stream.sounds ?? defaultSounds;
    const sounds = validateSounds({ ...saved, choices: { ...saved.choices, [event]: req.body.choices } });
    checkSoundFiles(soundsFor(sounds, event).filter(choice => choice.startsWith('file:')).map(choice => choice.slice(5)));
    saveSounds(res, stream, sounds, appearance(stream).sound);
  });
  api.post('/sprites', (req, res) => {
    const stream = get(res);
    const { id, file, kind = 'player', scope, slot = 1 } = req.body ?? {};
    if ((kind !== 'player' && kind !== 'pokemon')
        || !stream.config?.players.some(player => player.id === id)
        || (scope !== undefined && scope !== scopeFor(stream.config))) {
      throw new Error('Selecciona un jugador guardado.');
    }
    if (kind === 'pokemon' && !teamSlots.includes(slot)) throw new Error('Elige un espacio del equipo del 1 al 6.');
    const key = kind === 'pokemon' ? pokemonKey(stream, id, slot) : spriteKey(stream, id);
    stream.sprites ??= {};
    if (file === null) delete stream.sprites[key];
    else {
      const category = kind === 'pokemon' ? 'pokemon' : 'players';
      if (typeof file !== 'string' || !library.find(category, file)) throw new Error('Selecciona un archivo de la carpeta correspondiente.');
      stream.sprites[key] = { file };
    }
    store.save(stream);
    broadcast(stream.live, styled(stream));
    broadcast(stream.preview, previewState(stream));
    send(res, stream);
  });
  api.post('/notice-gifs', (req, res) => {
    const stream = get(res);
    const { type, files } = req.body ?? {};
    if (!noticeTypes.includes(type) || !Array.isArray(files) || !files.every(file => library.find('gifs', file))) {
      throw new Error('Elige un tipo de aviso y archivos GIF de la carpeta media/gifs.');
    }
    stream.noticeGifs = { ...stream.noticeGifs, [type]: [...new Set<string>(files)] };
    store.save(stream);
    broadcast(stream.live, styled(stream));
    broadcast(stream.preview, previewState(stream));
    send(res, stream);
  });
  api.post('/tracking', (req, res) => {
    const stream = get(res);
    if (typeof req.body?.active !== 'boolean') throw new Error('Indica si quieres iniciar o pausar el seguimiento.');
    if (req.body.active) {
      if (!stream.config) throw new Error('Guarda un torneo y sus jugadores para empezar.');
      if (!stream.live) throw new Error('Genera un enlace de directo para empezar.');
      stream.activeUntil = Date.now() + liveLifetime;
      stream.status = { ...stream.status, phase: 'syncing', message: 'Consultando PokéData…' };
    } else {
      stream.activeUntil = null;
      lastRead.delete(stream.owner);
      stream.status = { ...stream.status, phase: 'paused', message: 'Seguimiento en pausa.' };
    }
    store.save(stream);
    send(res, stream);
    if (stream.activeUntil) void poll(stream.owner);
  });
  api.post('/demo', (req, res) => {
    const stream = get(res);
    if (!stream.preview) throw new Error('Genera el enlace de ensayo para probar un aviso.');
    const scenario: Scenario = req.body?.scenario;
    if (!scenarios.includes(scenario)) throw new Error('Elige un escenario válido.');
    const result = simulateTrial(scenario, stream.config);
    previews.set(stream.preview, scenario);
    broadcast(stream.preview, styled(stream, result.state), result.notices);
    res.sendStatus(204);
  });
  api.post('/demo/controls', (req, res) => {
    const stream = get(res);
    if (!stream.preview) throw new Error('Genera el enlace de ensayo para usar estos controles.');
    const { test, stop } = req.body ?? {};
    if (stop === true && test === undefined) {
      previews.delete(stream.preview);
      broadcast(stream.preview, previewState(stream), [], { stop: true });
    } else if (trialPresets.includes(test) && stop === undefined) {
      broadcast(stream.preview, previewState(stream), [], { test });
    } else throw new Error('Selecciona una prueba válida.');
    res.sendStatus(204);
  });
  api.post('/links', (req, res) => {
    const stream = get(res);
    const { kind, action } = req.body ?? {};
    if ((kind !== 'live' && kind !== 'preview') || (action !== 'rotate' && action !== 'revoke')) throw new Error('Acción de enlace inválida.');
    const slot: 'live' | 'preview' = kind;
    const previous = stream[slot];
    stream[slot] = action === 'rotate' ? token() : null;
    if (slot === 'live' && action === 'revoke') {
      stream.activeUntil = null;
      setProgramMenu(stream, null);
      stream.status = { ...stream.status, phase: 'paused', message: 'El enlace de directo ha sido revocado.' };
    }
    store.save(stream);
    revoke(previous);
    send(res, stream);
  });
  site.use('/api/panel', api);

  function lookup(req: Request) {
    const link = String(req.params.link);
    return linkPattern.test(link) ? store.byLink(link) : null;
  }
  site.get('/o/:link', (req, res) => {
    if (!lookup(req)) { res.status(404).type('text').send('Este enlace de overlay ya no está disponible.'); return; }
    res.sendFile('overlay.html', uiFiles);
  });
  site.get('/o/:link/state', (req, res) => {
    const stream = lookup(req);
    if (!stream) { res.sendStatus(404); return; }
    res.json(stream.preview === req.params.link ? previewState(stream) : styled(stream));
  });
  site.get('/o/:link/history/:id', async (req, res) => {
    const stream = lookup(req);
    const config = stream?.config;
    const id = Number(req.params.id);
    if (!config?.players.some(player => player.id === id) || !stream) { res.sendStatus(404); return; }
    let card = stream.overlay.cards.find(card => card.selection.id === id);
    if (!card?.matchHistory) {
      try {
        const reading = await source.read(config);
        card = reconcile(config, reading.snapshot, null).state.cards.find(card => card.selection.id === id);
      } catch {
        res.status(503).json({ error: 'PokéData no está disponible. Vuelve a abrir el historial para reintentar.' });
        return;
      }
    }
    const current = lookup(req);
    if (!current || current.generation !== stream.generation) { res.sendStatus(404); return; }
    res.json({ matches: card?.matchHistory ?? [] });
  });
  function serveSprite(res: Response, sprite: Sprite | undefined, version: string, category: Category) {
    if (!sprite) { res.sendStatus(404); return; }
    if ('file' in sprite) {
      const asset = library.find(category, sprite.file);
      if (!asset || asset.version !== version) { res.sendStatus(404); return; }
      res.type(asset.mime).sendFile(path.basename(asset.full), { root: path.dirname(asset.full) });
    } else if (sprite.version === version) res.type(sprite.mime).send(Buffer.from(sprite.data, 'base64'));
    else res.sendStatus(404);
  }
  site.get('/o/:link/media/sounds/:name', (req, res) => {
    const stream = lookup(req);
    const name = req.params.name;
    if (!stream || !soundFiles(stream.sounds ?? defaultSounds).includes(name)) { res.sendStatus(404); return; }
    serveAsset(res, 'sounds', name);
  });
  site.get('/o/:link/gifs/:type/:name', (req, res) => {
    const stream = lookup(req);
    const { type, name } = req.params;
    if (!noticeTypes.includes(type as NoticeType) || !stream || !selectedGifs(stream)[type as NoticeType]?.includes(name)) {
      res.sendStatus(404);
      return;
    }
    serveAsset(res, 'gifs', name);
  });
  site.get('/o/:link/pokemon/:id/:slot/:version', (req, res) => {
    const stream = lookup(req);
    const id = Number(req.params.id);
    const slot = teamSlots.find(slot => String(slot) === req.params.slot);
    if (!stream?.config?.players.some(player => player.id === id) || !slot) { res.sendStatus(404); return; }
    serveSprite(res, stream.sprites?.[pokemonKey(stream, id, slot)], req.params.version, 'pokemon');
  });
  site.get('/o/:link/:kind/:id/:version', (req, res) => {
    const stream = lookup(req);
    if (!stream) { res.sendStatus(404); return; }
    const { kind, id, version } = req.params;
    if (kind !== 'sprite' && kind !== 'pokemon') { res.sendStatus(404); return; }
    const player = stream.config?.players.find(player => player.id === Number(id));
    serveSprite(res, player ? stream.sprites?.[spriteKey(stream, player.id, kind === 'pokemon' ? kind : 'player')] : undefined, version,
      kind === 'pokemon' ? 'pokemon' : 'players');
  });
  site.get('/o/:link/events', (req, res) => {
    const stream = lookup(req);
    if (!stream) { res.sendStatus(404); return; }
    const link = req.params.link;
    const clients = subscribers.get(link) ?? new Set<Response>();
    if (clients.size >= 12 || subscribers.size >= 1000) { res.sendStatus(429); return; }
    subscribers.set(link, clients);
    clients.add(res);
    res.set({ 'Content-Type': 'text/event-stream; charset=utf-8', 'X-Accel-Buffering': 'no', 'Cache-Control': 'no-cache, no-store, no-transform' });
    res.flushHeaders();
    res.write(packet(stream.preview === link ? previewState(stream) : styled(stream), []));
    const ping = setInterval(() => res.write(': keep-alive\n\n'), 15_000);
    res.on('close', () => { clearInterval(ping); clients.delete(res); if (!clients.size && subscribers.get(link) === clients) subscribers.delete(link); });
  });

  site.use((error: unknown, _req: Request, res: Response, _next: express.NextFunction) => {
    const e = error as { type?: string };
    if (e.type?.startsWith('entity.')) { res.status(400).json({ error: 'La petición no tiene un formato válido.' }); return; }
    res.status(400).json({ error: errorMessage(error) });
  });
  const timer = setInterval(() => {
    for (const stream of store.active()) if (Object.hasOwn(options.codes, stream.owner)) void poll(stream.owner);
  }, Math.min(1000, Math.max(10, (options.intervalMs ?? 60_000) / 4)));
  timer.unref();
  const maintenance = setInterval(() => store.cleanup(), 3_600_000);
  maintenance.unref();
  return { app: site, async close() {
    clearInterval(timer);
    clearInterval(maintenance);
    for (const clients of subscribers.values()) for (const res of clients) res.end();
    while (activeWork.size) await new Promise(resolve => setTimeout(resolve, 25));
    store.close();
  } };
}
