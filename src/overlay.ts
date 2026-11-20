import { simulateTrial, scenarios, trialPresets } from './trials.ts';
import type { TrialPreset } from './trials.ts';
import { resolveAppearance, sharesPosition } from './appearance.ts';
import type { Appearance } from './appearance.ts';
import { teamSlots } from './model.ts';
import type { Card, Match, Notice, OverlayState, Scenario, ScoreMenu, SpritePreview } from './model.ts';
import { outcomeLabel } from './state.ts';
import { defaultSoundMix, defaultSounds, isMenuSound, menuSoundEvent, noticeType, pickSound, playTone, soundsFor, soundVolume } from './sounds.ts';
import type { NoticeType, SoundChoice, SoundEvent, Tone } from './sounds.ts';
import { pickNoticeGif } from './media-types.ts';
import { spriteElement } from './sprite.ts';
import { clearAsset, hostedOnPages, serviceFetch, serviceUrl, setAsset } from './browser-service.ts';

const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const noticeView = el('notice');
const noticeCopy = el('notice-copy');
const noticeGif = el<HTMLImageElement>('notice-gif');
const lastGif = new Map<NoticeType, string>();
let gifChoice: { id: string; file?: string } | undefined;
const pending: Notice[] = [];
const seen = new Set<string>();
let state: OverlayState;
let playing = false;
let currentNotice: Notice | undefined;
let noticeTimer: ReturnType<typeof setTimeout>;
let transition: Animation | undefined;
let effect: Animation | undefined;
let boardVisible = false;
let boardAnimation: Animation | undefined;
let boardEffect: Animation | undefined;
let audio: AudioContext | null = null;
let mediaSound: HTMLAudioElement | undefined;
let menuSound: HTMLAudioElement | undefined;
let noticeTone: (() => void) | undefined;
let menuTone: (() => void) | undefined;
let menuSoundRevision = 0;
const lastSound = new Map<SoundEvent, SoundChoice>();
let openMenu: ScoreMenu | null = null;
let lastProgramRevision: number | undefined;
let rowsVersion = '';
let menuVersion = '';
let historyRequest: AbortController | undefined;
const scoreMenu = el('score-menu');
let overlayPath = location.pathname.startsWith('/o/') ? location.pathname.replace(/\/$/, '') : '';
let previewPlayers: SpritePreview['players'] | undefined;
const previewParams = new URLSearchParams(location.search);
const view = hostedOnPages ? previewParams.get('view') : location.pathname.split('/').at(-1);
const embeddedPreview = view === 'sprite-preview';
const liveMonitor = view === 'live-view';
const previewCue = embeddedPreview ? previewParams.get('cue') : null;
function signalPreviewSound() {
  if (previewCue) window.parent.postMessage({ type: 'koi-sound-preview', cue: previewCue }, location.origin);
}

function text<T extends keyof HTMLElementTagNameMap>(tag: T, value: string, className?: string) {
  const element = document.createElement(tag);
  element.textContent = value;
  if (className) element.className = className;
  return element;
}

function playerName(card: Card) { return card.selection.alias || card.selection.name; }

function pokemonSprite(card: Card, slot: number, version: string) {
  const file = previewPlayers?.[card.selection.id]?.team[slot - 1];
  const url = file ? `/api/panel/media/pokemon/${encodeURIComponent(file)}`
    : overlayPath && `${overlayPath}/pokemon/${card.selection.id}/${slot}/${version}`;
  if (!url) return null;
  const sprite = spriteElement(url, `Pokémon ${slot}`,
    card.teamVideoSlots?.includes(slot));
  sprite.className = 'player-sprite';
  return sprite;
}

function drawHistory(container: HTMLElement, matches: Match[]) {
  if (!matches.length) { container.replaceChildren(text('p', 'Todavía no hay cruces publicados.')); return; }
  const table = document.createElement('table');
  const heading = table.createTHead().insertRow();
  for (const label of ['Ronda', 'Rival', 'Mesa', 'Resultado']) {
    const cell = text('th', label);
    cell.scope = 'col';
    heading.append(cell);
  }
  const body = table.createTBody();
  for (const match of [...matches].reverse()) {
    const row = body.insertRow();
    for (const value of [String(match.round), match.opponent?.name ?? '—', String(match.table ?? '—')]) row.append(text('td', value));
    const result = text('td', outcomeLabel[match.outcome], 'outcome');
    result.dataset.outcome = match.outcome;
    row.append(result);
  }
  container.replaceChildren(table);
}

function closeMenu() {
  const previous = openMenu;
  openMenu = null;
  renderMenu();
  playMenuChange(previous);
  if (previous && !el('scoreboard').inert) {
    document.querySelector<HTMLButtonElement>(`.score-menu-action[data-kind="${previous.kind}"][data-player="${previous.id}"]`)?.focus();
  }
}

function renderMenu() {
  const card = state?.cards.find(card => card.selection.id === openMenu?.id);
  const enabled = state?.appearance?.scoreboard !== false;
  for (const button of document.querySelectorAll<HTMLButtonElement>('.score-menu-action')) {
    button.setAttribute('aria-expanded', String(Boolean(openMenu && enabled && openMenu.kind === button.dataset.kind
      && String(openMenu.id) === button.dataset.player)));
  }
  if (!openMenu || !card || !enabled) {
    openMenu = null;
    scoreMenu.hidden = true;
    menuVersion = '';
    historyRequest?.abort();
    return;
  }
  const { kind } = openMenu;
  const version = JSON.stringify([state.title, card.selection, kind, kind === 'team' ? [card.team, card.teamVideoSlots] : card.historyVersion]);
  if (version === menuVersion) return;
  menuVersion = version;
  historyRequest?.abort();
  scoreMenu.hidden = false;
  el('score-menu-title').textContent = `${kind === 'team' ? 'Equipo' : 'Historial'} de ${playerName(card)}`;
  const content = el('score-menu-content');
  if (kind === 'team') {
    const team = document.createElement('ol');
    team.className = 'score-team';
    for (const slot of teamSlots) {
      const item = document.createElement('li');
      const version = card.team?.[slot - 1];
      const frame = text('div', '', 'team-frame');
      const inset = text('div', '', 'team-frame-inset');
      inset.append((version && pokemonSprite(card, slot, version)) || text('span', 'Sin sprite', 'slot-empty'));
      frame.append(inset);
      item.append(frame);
      team.append(item);
    }
    content.replaceChildren(team);
    return;
  }
  if (!overlayPath || card.selection.id < 0) {
    drawHistory(content, card.matchHistory ?? (card.match ? [card.match] : []));
    return;
  }
  const request = new AbortController();
  historyRequest = request;
  content.replaceChildren(text('p', 'Cargando rondas de PokéData…'));
  void (async () => {
    try {
      const response = await serviceFetch(`${overlayPath}/history/${card.selection.id}`, { signal: request.signal });
      if (!response.ok) throw new Error();
      const { matches } = await response.json() as { matches: Match[] };
      if (!request.signal.aborted) drawHistory(content, matches);
    } catch {
      if (!request.signal.aborted) content.replaceChildren(text('p', 'No se pudo cargar el historial. Cierra y vuelve a abrir el menú para reintentar.'));
    }
  })();
}

function menuButton(card: Card, kind: ScoreMenu['kind']) {
  const button = document.createElement('button');
  const label = kind === 'team' ? 'Equipo Pokémon' : 'Historial de partidas';
  button.type = 'button';
  button.className = 'score-menu-action';
  button.dataset.kind = kind;
  button.dataset.player = String(card.selection.id);
  button.title = label;
  button.setAttribute('aria-label', `${label} de ${playerName(card)}`);
  button.setAttribute('aria-controls', 'score-menu');
  const icon = text('span', '', kind === 'team' ? 'ball-icon' : 'dex-icon');
  icon.setAttribute('aria-hidden', 'true');
  button.append(icon);
  button.addEventListener('click', () => {
    const previous = openMenu;
    openMenu = openMenu?.id === card.selection.id && openMenu.kind === kind ? null : { id: card.selection.id, kind };
    renderMenu();
    playMenuChange(previous);
  });
  return button;
}

function render(next: OverlayState) {
  state = next;
  const previousMenu = openMenu;
  let playProgramMenu = false;
  if (next.programMenu && lastProgramRevision !== next.programMenu.revision) {
    playProgramMenu = lastProgramRevision !== undefined;
    lastProgramRevision = next.programMenu.revision;
    openMenu = next.programMenu.selected;
  }
  const sounds = next.sounds ?? defaultSounds;
  const mix = sounds.mix ?? defaultSoundMix;
  for (const [clip, event] of [[mediaSound, 'win'], [menuSound, 'team']] as const) {
    if (!clip) continue;
    const volume = next.sound ? soundVolume(sounds.volume, mix, event) : 0;
    if (!volume) clip.pause();
    else clip.volume = volume / 100;
  }
  const settings = resolveAppearance(next.appearance);
  const root = document.documentElement.style;
  root.setProperty('--accent', next.color);
  root.setProperty('--score-scale', String(settings.scoreboardSize / 100));
  root.setProperty('--alert-scale', String(settings.alertSize / 100));
  root.setProperty('--margin-x', `${settings.marginX}vw`);
  root.setProperty('--margin-y', `${settings.marginY}vh`);
  root.setProperty('--score-opacity', String(settings.scoreboardOpacity / 100));
  root.setProperty('--alert-opacity', String(settings.alertOpacity / 100));
  const scoreAnchor = el('score-anchor');
  const alertAnchor = el('alert-anchor');
  for (const [anchor, position, offset] of [[scoreAnchor, settings.scoreboardPosition, settings.scoreboardOffset],
    [alertAnchor, settings.alertPosition, settings.alertOffset]] as const) {
    const [y, x] = position.split('-');
    anchor.dataset.x = x;
    anchor.dataset.y = y;
    anchor.style.setProperty('--offset-x', `${offset.x}vw`);
    anchor.style.setProperty('--offset-y', `${offset.y}vh`);
  }
  const target = sharesPosition(settings) && !settings.hideScoreboardDuringAlert ? scoreAnchor : alertAnchor;
  if (noticeView.parentElement !== target) target.prepend(noticeView);
  const board = el('scoreboard');
  noticeView.dataset.style = settings.alertStyle === 'match' ? settings.scoreboardStyle : settings.alertStyle;
  noticeView.dataset.layout = settings.alertLayout;
  const fields = settings.scoreboardFields;
  board.dataset.style = settings.scoreboardStyle;
  board.dataset.logo = String(fields.logo);
  el('score-brand').hidden = !fields.logo;
  const context = [fields.tournament && next.title, fields.round && next.round && `Ronda ${next.round}`].filter(Boolean).join(' · ');
  el('score-context').hidden = !context && !next.simulation;
  el('tournament-title').textContent = context;
  el('simulation').hidden = !next.simulation;
  const cards = fields.reverse ? [...next.cards].reverse() : next.cards;
  const version = JSON.stringify([fields, cards]);
  if (version !== rowsVersion) {
    rowsVersion = version;
    el('players').replaceChildren(...cards.map(card => {
      const match = card.match;
      const player = document.createElement('article');
      player.className = 'score-player';
      const name = playerName(card);
      const portrait = document.createElement('div');
      portrait.className = 'player-portrait';
      if (fields.avatar) {
        const file = previewPlayers?.[card.selection.id]?.avatar;
        const url = file ? `/api/panel/media/players/${encodeURIComponent(file)}`
          : card.sprite && overlayPath && `${overlayPath}/sprite/${card.selection.id}/${card.sprite}`;
        if (url) {
          const sprite = document.createElement('img');
          setAsset(sprite, url);
          sprite.alt = '';
          sprite.className = 'player-sprite player-avatar';
          portrait.append(sprite);
        } else {
          const initials = name.trim().split(/\s+/).slice(0, 2).map(word => Array.from(word)[0]).join('').toLocaleUpperCase('es');
          const placeholder = text('span', initials, 'player-initials');
          placeholder.setAttribute('aria-hidden', 'true');
          portrait.append(placeholder);
        }
      }
      const pokemon = fields.pokemon && card.pokemon && pokemonSprite(card, 1, card.pokemon);
      if (pokemon) {
        if (fields.avatar) pokemon.classList.add('pokemon-badge');
        portrait.append(pokemon);
      }
      if (portrait.childElementCount) player.append(portrait);
      const info = document.createElement('div');
      info.className = 'player-info';
      if (fields.name) info.append(text('h2', name));
      const actions = document.createElement('div');
      actions.className = 'score-menu-actions';
      const record = card.record?.split('–');
      if (fields.record && record?.length === 3) {
        const balance = document.createElement('span');
        balance.className = 'record-counts';
        balance.setAttribute('aria-label', `Balance: ${record[0]} victorias, ${record[1]} derrotas y ${record[2]} empates`);
        for (const [index, [letter, name]] of [['V', 'Victorias'], ['D', 'Derrotas'], ['E', 'Empates']].entries()) {
          const count = text('span', `${record[index]} ${letter}`);
          count.title = name;
          count.setAttribute('aria-hidden', 'true');
          balance.append(count);
        }
        actions.append(balance);
      }
      const meta = document.createElement('p');
      meta.className = 'summary';
      if (fields.outcome) {
        const status = text('span', card.missing ? 'Sin datos' : card.dropped ? 'Retirado' : match ? outcomeLabel[match.outcome] : 'Sin cruce', 'outcome');
        status.dataset.outcome = match?.outcome ?? '';
        meta.append(status);
      }
      if (fields.opponent && match?.opponent) meta.append(text('span', `vs. ${match.opponent.name}`));
      if (fields.table && match?.table) meta.append(text('span', `Mesa ${match.table}`));
      if (meta.childElementCount) info.append(meta);
      player.append(info);
      actions.append(menuButton(card, 'team'), menuButton(card, 'history'));
      player.append(actions);
      return player;
    }));
  }
  syncScoreboard(settings);
  renderMenu();
  if (playProgramMenu) playMenuChange(previousMenu);
  if (currentNotice) writeNotice(currentNotice);
}

function playMenuChange(previous: ScoreMenu | null) {
  const event = menuSoundEvent(previous, openMenu);
  if (!event) return;
  menuSound?.pause();
  menuTone?.();
  const revision = ++menuSoundRevision;
  if (event && state?.sound && state.appearance?.scoreboard !== false) {
    void playOverlaySound(event, () => menuSoundRevision === revision, clip => { menuSound = clip; }, stop => { menuTone = stop; });
  }
}

async function playOverlaySound(event: SoundEvent, isCurrent: () => boolean, storeClip: (clip: HTMLAudioElement) => void,
    storeTone: (stop: (() => void) | undefined) => void) {
  const settings = state.sounds ?? defaultSounds;
  const volume = soundVolume(settings.volume, settings.mix ?? defaultSoundMix, event);
  if (!volume) return;
  const choice = pickSound(soundsFor(settings, event), lastSound.get(event));
  if (!choice) return;
  lastSound.set(event, choice);
  let tone: Tone | undefined;
  try {
    if (choice.startsWith('tone:')) tone = choice.slice(5) as Tone;
    else if (overlayPath) {
      const clip = new Audio(serviceUrl(`${overlayPath}/media/sounds/${encodeURIComponent(choice.slice(5))}`));
      storeClip(clip);
      clip.volume = volume / 100;
      try { await clip.play(); return; }
      catch {
        if (!isCurrent() || !state.sound) return;
        if (!settings.choices?.[event] && !isMenuSound(event)) tone = settings.byType[event];
      }
    }
    if (!tone || tone === 'mute') return;
    audio ??= new AudioContext();
    if (audio.state !== 'running') {
      const started = await Promise.race([audio.resume().then(() => true), new Promise<false>(resolve => setTimeout(() => resolve(false), 350))]);
      if (!started || !isCurrent() || !state.sound) return;
    }
    storeTone(playTone(audio, tone, volume));
  } catch {}
}

function writeNotice(next: Notice) {
  const settings = resolveAppearance(state.appearance);
  const heading = next.kind === 'pairing' ? 'Nuevo cruce' : next.kind === 'correction'
    ? `Resultado corregido · ${outcomeLabel[next.outcome]}` : outcomeLabel[next.outcome];
  const title = next.names.length === 2 ? next.names.join(next.outcome === 'win' ? ' gana a ' : ' vs. ') : next.names[0];
  const details = [`Ronda ${next.round}`, settings.opponent && next.opponent && `vs. ${next.opponent}`,
    settings.table && next.table && `Mesa ${next.table}`, settings.record && next.record && `Balance ${next.record}`, next.score].filter(Boolean);
  const type = noticeType(next);
  noticeView.dataset.outcome = type ?? '';
  const label = text('div', '', 'notice-label');
  label.append(text('span', heading, 'notice-outcome'));
  if (state.simulation) label.append(text('span', 'ENSAYO', 'preview-label'));
  const metadata = text('div', '', 'notice-details');
  details.forEach(detail => metadata.append(text('span', String(detail))));
  noticeCopy.replaceChildren(label, text('strong', title), metadata);
  const files = type && state.gifs?.[type];
  if (!type || !files?.length || (!embeddedPreview && !overlayPath) || matchMedia('(prefers-reduced-motion: reduce)').matches) {
    noticeGif.hidden = true;
    clearAsset(noticeGif);
    return;
  }
  if (gifChoice?.id !== next.id) {
    const file = pickNoticeGif(files, lastGif.get(type));
    gifChoice = { id: next.id, file };
    if (file) lastGif.set(type, file);
  }
  if (!gifChoice.file || !files.includes(gifChoice.file)) {
    noticeGif.hidden = true;
    clearAsset(noticeGif);
    return;
  }
  const directory = embeddedPreview ? '/api/panel/media/gifs' : `${overlayPath}/gifs/${type}`;
  const url = `${directory}/${encodeURIComponent(gifChoice.file)}?notice=${encodeURIComponent(next.id)}`;
  if (noticeGif.getAttribute('src') !== url) {
    noticeGif.dataset.loading = '';
    noticeGif.hidden = false;
    setAsset(noticeGif, url);
  }
}

function stopNotices() {
  clearTimeout(noticeTimer);
  transition?.cancel();
  effect?.cancel();
  mediaSound?.pause();
  noticeTone?.();
  pending.length = 0;
  currentNotice = undefined;
  playing = false;
  noticeView.hidden = true;
  syncScoreboard();
  noticeGif.hidden = true;
  clearAsset(noticeGif);
}

const motionTransforms = {
  top: 'translateY(-32px)', bottom: 'translateY(32px)', left: 'translateX(-44px)', right: 'translateX(44px)',
  fade: 'none', zoom: 'scale(.88)', reveal: 'none', none: 'none',
};

function animateEntrance(target: HTMLElement, entrance: Appearance['entrance'], duration: number, opacity: number) {
  return target.animate(entrance === 'reveal'
    ? [{ clipPath: 'inset(0 100% 0 0)' }, { clipPath: 'inset(0 0% 0 0)' }]
    : [{ opacity: 0, transform: motionTransforms[entrance] }, { opacity, transform: 'none' }],
    { duration, easing: 'cubic-bezier(.16,1,.3,1)' });
}

function animateExit(target: HTMLElement, exit: Exclude<Appearance['alertExit'], 'match'>, duration: number) {
  return target.animate([{ opacity: getComputedStyle(target).opacity, transform: getComputedStyle(target).transform },
    { opacity: 0, transform: motionTransforms[exit] }], { duration, easing: 'ease-in', fill: 'forwards' });
}

function animateEffect(layer: HTMLElement, kind: Appearance['alertEffect'], duration: number) {
  layer.dataset.effect = kind;
  return layer.animate(kind === 'sweep'
    ? [{ opacity: 0, transform: 'translateX(-85%)' }, { opacity: .65, offset: .4 }, { opacity: 0, transform: 'translateX(85%)' }]
    : [{ opacity: 0 }, { opacity: .9, offset: .3 }, { opacity: 0 }],
    { duration: Math.max(duration, 500), easing: 'ease-out' });
}

function syncScoreboard(settings = resolveAppearance(state?.appearance)) {
  const visible = Boolean(settings.scoreboard && state?.cards.length &&
    (noticeView.hidden || !settings.hideScoreboardDuringAlert));
  setScoreboardVisible(visible, settings);
}

function setScoreboardVisible(visible: boolean, settings: Appearance, immediate = false) {
  if (boardVisible === visible && !immediate) return;
  boardVisible = visible;
  if (!visible) { menuSound?.pause(); menuTone?.(); menuSoundRevision++; }
  const board = el('scoreboard');
  board.inert = !visible;
  const { entrance, exit: configuredExit, effect, entranceMs, exitMs } = settings.scoreboardMotion;
  const exit = configuredExit === 'match' ? (entrance === 'none' ? 'none' : 'fade') : configuredExit;
  const motion = !immediate && !matchMedia('(prefers-reduced-motion: reduce)').matches;
  const previous = boardAnimation;
  boardAnimation = undefined;
  boardEffect?.cancel();
  if (visible) {
    previous?.cancel();
    board.hidden = false;
    if (motion && entrance !== 'none') boardAnimation = animateEntrance(board, entrance, entranceMs, settings.scoreboardOpacity / 100);
    if (motion && effect !== 'none') boardEffect = animateEffect(el('score-effect-layer'), effect, entrance === 'none' ? 0 : entranceMs);
  } else if (!board.hidden && motion && exit !== 'none') {
    const leaving = animateExit(board, exit, exitMs);
    boardAnimation = leaving;
    previous?.cancel();
    void leaving.finished.then(() => {
      if (boardAnimation !== leaving) return;
      board.hidden = true;
      leaving.cancel();
      boardAnimation = undefined;
    }, () => {});
  } else {
    previous?.cancel();
    board.hidden = true;
  }
}

function play() {
  const next = pending.shift();
  if (!next) { playing = false; return; }
  currentNotice = next;
  playing = true;
  const { entrance, entranceMs, alertExit, exitMs, alertGapMs, alertEffect, alertOpacity } = resolveAppearance(state.appearance);
  const duration = state.duration * 1000;
  const motion = !matchMedia('(prefers-reduced-motion: reduce)').matches;
  const exit = alertExit === 'match' ? (entrance === 'none' ? 'none' : 'fade') : alertExit;
  const entryTime = motion && entrance !== 'none' ? entranceMs : 0;
  writeNotice(next);
  noticeView.hidden = false;
  syncScoreboard();
  signalPreviewSound();
  const type = noticeType(next);
  if (state.sound && type) {
    mediaSound?.pause();
    void playOverlaySound(type, () => currentNotice === next, clip => { mediaSound = clip; }, stop => { noticeTone = stop; });
  }
  if (entryTime) transition = animateEntrance(noticeView, entrance, entryTime, alertOpacity / 100);
  if (motion && alertEffect !== 'none') {
    effect?.cancel();
    effect = animateEffect(el('notice-effect'), alertEffect, entryTime);
  }
  noticeTimer = setTimeout(() => {
    const finish = () => {
      mediaSound?.pause();
      noticeTone?.();
      currentNotice = undefined;
      noticeView.hidden = true;
      noticeGif.hidden = true;
      clearAsset(noticeGif);
      if (!alertGapMs && pending.length) { play(); return; }
      syncScoreboard();
      noticeTimer = setTimeout(play, alertGapMs);
    };
    if (!motion || exit === 'none') finish();
    else {
      const ending = animateExit(noticeView, exit, exitMs);
      transition = ending;
      void ending.finished.then(() => { finish(); ending.cancel(); }, () => {});
    }
  }, entryTime + duration);
}

function receive(current: OverlayState, notices: Notice[]) {
  render(current);
  if (current.appearance?.alerts === false && !current.simulation) { stopNotices(); return; }
  for (const notice of notices) {
    if (seen.has(notice.id)) continue;
    seen.add(notice.id);
    if (seen.size > 400) seen.delete(seen.values().next().value!);
    pending.push(notice);
  }
  if (!playing) play();
}

if (liveMonitor) {
  void (async () => {
    try {
      const response = await serviceFetch('/api/panel/live-view/source');
      if (!response.ok) throw new Error();
      const { path } = await response.json() as { path: string };
      overlayPath = path;
      connectOverlay(path);
    } catch {
      el('message').textContent = 'No se pudo conectar con la fuente de directo.';
      el('message').hidden = false;
    }
  })();
} else if (embeddedPreview) {
  document.body.classList.add('sprite-preview-page');
  void (async () => {
    try {
      const response = await serviceFetch('/api/panel/sprite-preview/state' + location.search);
      if (!response.ok) throw new Error();
      const preview: SpritePreview = await response.json();
      overlayPath = preview.legacySource;
      previewPlayers = preview.players;
      receive(preview.state, preview.notices);
      if (!preview.notices.length && preview.state.programMenu?.selected) {
        if (previewParams.get('soundPreview')?.endsWith('-close')) {
          const visible = boardAnimation?.finished ?? Promise.resolve();
          void visible.catch(() => {}).then(() => { setTimeout(() => { closeMenu(); signalPreviewSound(); }, 650); });
        } else signalPreviewSound();
      }
      if (!preview.state.appearance?.scoreboard && !preview.notices.length) {
        el('message').textContent = 'El marcador está oculto en Diseño.';
        el('message').hidden = false;
      }
    } catch {
      el('message').textContent = 'No se pudo cargar la vista previa.';
      el('message').hidden = false;
    }
  })();
} else if (overlayPath) connectOverlay(overlayPath);

function connectOverlay(path: string) {
  const channel = new EventSource(serviceUrl(path + '/events'));
  const linkedPreset = trialPresets.find(value => value === previewParams.get('ensayo'));
  let latestTrial: OverlayState | undefined;
  let trialTimer: ReturnType<typeof setTimeout> | undefined;
  function stopTrial(base: OverlayState) {
    clearTimeout(trialTimer);
    stopNotices();
    menuSound?.pause();
    menuTone?.();
    menuSoundRevision++;
    openMenu = null;
    const settings = resolveAppearance(base.appearance);
    setScoreboardVisible(settings.scoreboard && base.cards.length > 0, settings, true);
    render(base);
    el('message').hidden = true;
  }
  function runTrial(base: OverlayState, preset: TrialPreset) {
    stopTrial(base);
    const scenario = scenarios.find(value => value === preset);
    if (scenario) {
      const sample = simulateTrial(scenario);
      const cards = base.cards.map((card, index) => ({ ...card, match: sample.state.cards[index]?.match ?? card.match,
        record: sample.state.cards[index]?.record ?? card.record }));
      const notices = sample.notices.map((notice, index) => ({
        ...notice, names: base.cards[index] ? [playerName(base.cards[index])] : notice.names,
      }));
      receive({ ...base, round: sample.state.round, cards }, notices);
      return;
    }
    const settings = resolveAppearance(base.appearance);
    const fixture = (scoreboard: boolean) => ({ ...base, appearance: { ...settings, scoreboard } });
    if (preset === 'marcador-mostrar' || preset === 'marcador-ocultar') {
      const show = preset === 'marcador-mostrar';
      render(fixture(!show));
      trialTimer = setTimeout(() => render(fixture(show)),
        Math.max(350, show ? settings.scoreboardMotion.exitMs : settings.scoreboardMotion.entranceMs));
    } else if (preset === 'conexion') {
      render(fixture(true));
      el('message').textContent = 'Conexión de prueba activa';
      el('message').hidden = false;
    } else if (isMenuSound(preset) && base.cards[0]) {
      render(fixture(true));
      const kind = preset.startsWith('team') ? 'team' : 'history';
      openMenu = { id: base.cards[0].selection.id, kind };
      renderMenu();
      if (preset.endsWith('-close')) trialTimer = setTimeout(closeMenu, Math.max(650, settings.scoreboardMotion.entranceMs));
      else playMenuChange(null);
    }
  }
  el('replay-linked-trial').addEventListener('click', () => { if (latestTrial && linkedPreset) runTrial(latestTrial, linkedPreset); });
  el('stop-linked-trial').addEventListener('click', () => { if (latestTrial) stopTrial(latestTrial); });
  channel.addEventListener('state', event => {
    const { state, notices, control } = JSON.parse(event.data) as { state: OverlayState; notices: Notice[];
      control?: { test: TrialPreset } | { stop: true } };
    const firstTrial = !latestTrial && state.simulation ? linkedPreset : undefined;
    if (state.simulation) latestTrial = state;
    clearTimeout(trialTimer);
    receive(liveMonitor ? { ...state, sound: false } : state, notices);
    el('message').hidden = true;
    if (state.simulation && control && 'stop' in control) stopTrial(state);
    else if (state.simulation && control && 'test' in control) runTrial(state, control.test);
    else if (firstTrial) {
      el('linked-trial-actions').hidden = previewParams.get('controles') !== '1';
      runTrial(state, firstTrial);
    }
  });
  channel.addEventListener('revoked', () => {
    channel.close();
    clearTimeout(trialTimer);
    latestTrial = undefined;
    el('linked-trial-actions').hidden = true;
    stopNotices();
    noticeCopy.replaceChildren();
    noticeView.hidden = true;
    setScoreboardVisible(false, resolveAppearance(state?.appearance), true);
    closeMenu();
    el('message').textContent = 'Enlace revocado. Copia el nuevo enlace desde el panel.';
    el('message').hidden = false;
  });
  channel.addEventListener('error', () => {
    if (state) return;
    el('message').textContent = 'Esperando conexión con el marcador…';
    el('message').hidden = false;
  });
}

noticeGif.addEventListener('load', () => { delete noticeGif.dataset.loading; });
noticeGif.addEventListener('error', () => { noticeGif.hidden = true; });
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && openMenu) closeMenu();
});
