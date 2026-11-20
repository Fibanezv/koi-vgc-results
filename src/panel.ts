import type { Config, Division, Entry, PanelState, Scenario, ScoreMenu, Setup } from './model.ts';
import type { MediaCatalog } from './media-types.ts';
import { teamSlots } from './model.ts';
import type { Appearance } from './appearance.ts';
import { resolveAppearance, scoreboardFieldKeys, sharesPosition } from './appearance.ts';
import { defaultNoticeGifs } from './media-types.ts';
import { outcomeLabel } from './state.ts';
import { defaultSoundMix, defaultSounds, menuSoundEvent, menuSoundTypes, noticeNames, noticeTypes, pickSound, playTone, soundNames, soundsFor, soundVolume, tones } from './sounds.ts';
import type { NoticeType, SoundChoice, SoundEvent, SoundMix, Tone } from './sounds.ts';
import type { TrialPreset } from './trials.ts';
import { spriteElement } from './sprite.ts';

const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const input = (id: string) => el<HTMLInputElement>(id);
const button = (id: string) => el<HTMLButtonElement>(id);
const select = (id: string) => el<HTMLSelectElement>(id);
const normalizeCatalogText = (value: string) => value.normalize('NFD').replace(/\p{M}/gu, '')
  .toLocaleLowerCase('es').replace(/[_-]+/g, ' ');
function catalogMatcher(query: string) {
  const words = normalizeCatalogText(query).trim().split(/\s+/);
  return (value: string) => {
    const text = normalizeCatalogText(value);
    return words.every(word => text.includes(word));
  };
}
const generalControls = [
  ['scoreboardOpacity', 'scoreboard-opacity'], ['alertOpacity', 'alert-opacity'],
  ['marginX', 'margin-x'], ['marginY', 'margin-y'],
] as const;
async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (response.status === 401 && location.pathname === '/panel') {
    location.replace('/');
    throw new Error('La sesión ha caducado.');
  }
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw new Error(payload?.error ?? 'La aplicación no pudo completar la solicitud.');
  }
  return response.status === 204 ? undefined as T : response.json() as Promise<T>;
}
const call = <T>(path = '', body?: unknown) => api<T>('/api/panel' + path, body);

function bindLogin() {
  el('login').addEventListener('submit', async event => {
    event.preventDefault();
    try {
      await api('/api/login', { code: input('code').value });
      location.assign('/panel');
    } catch (error) { el('login-error').textContent = (error as Error).message; }
  });
}

const phases = { idle: 'Sin configurar', syncing: 'Sincronizando', live: 'En seguimiento', waiting: 'Esperando ronda', error: 'Error de sincronización', paused: 'En pausa' };
const time = (value: string | number) => new Date(value).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

function bindPanel() {
  let state: PanelState;
  let setup: Setup | null = null;
  let busy = false;
  let toast: ReturnType<typeof setTimeout>;
  let revision = 0;
  const labels = new Map<string, number>();
  const players = [select('player-1'), select('player-2')];
  const flagKeys = ['scoreboard', 'alerts', 'opponent', 'table', 'record'] as const;
  let aliasScope = '';
  let visualDirty = false;
  let spriteFingerprint = '';
  let gifFingerprint = '';
  let currentGifType: NoticeType = 'win';
  let gifPreviewFile: string | undefined;
  let gifNoticeMode = false;
  let gifViewActive = false;
  let gifReplay = 0;
  let teamSceneVersion = '';
  const gifDrafts = new Map<NoticeType, string[]>();
  let menusFingerprint = '';
  let soundEdit = 0;
  let savedSoundEdit = 0;
  let panelAudio: AudioContext | undefined;
  let soundNoticeType: NoticeType = 'win';
  let soundMenuType: typeof menuSoundTypes[number] = 'team';
  let soundPreviewChoice: SoundChoice | undefined;
  let soundPreviewRun = 0;
  let soundPreviewCue: { id: string; play: () => void; volume: number } | undefined;
  let soundPreviewSource: AudioBufferSourceNode | undefined;
  let soundFingerprint = '';
  let soundEditorActive = false;
  let lastSoundEvent: SoundEvent | undefined;
  const soundDrafts = new Map<SoundEvent, SoundChoice[]>();
  let catalog: MediaCatalog = { players: [], pokemon: [], gifs: [], sounds: [] };
  let catalogReady = false;
  let originDirty = false;
  let originEdit = 0;
  let openPokemonPicker: HTMLDetailsElement | undefined;
  let dashboardTest: Scenario | 'team' | 'history' | undefined;
  let dashboardLiveUrl = '';
  let dashboardReplay = 0;
  const lastDashboardSound = new Map<SoundEvent, SoundChoice>();
  const navigation = [...document.querySelectorAll<HTMLAnchorElement>('[data-nav]')];
  const pages = [...document.querySelectorAll<HTMLElement>('[data-view]')];
  const urlCopyControls = [...document.querySelectorAll<HTMLButtonElement>('[data-copy-url]')].map(control => ({
    control, field: input(control.dataset.copyUrl!),
  }));
  function selectTab(container: HTMLElement | undefined, name?: string) {
    const tabs = [...(container?.querySelectorAll<HTMLButtonElement>(':scope > [role=tablist] > [data-tab]') ?? [])];
    const selected = tabs.find(tab => tab.dataset.tab === name)
      ?? tabs.find(tab => tab.getAttribute('aria-selected') === 'true');
    for (const tab of tabs) {
      const active = tab === selected;
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
      el(tab.getAttribute('aria-controls')!).hidden = !active;
    }
    return selected;
  }
  function navigate() {
    const [section, requestedTab, requestedSubtab] = location.hash.slice(1).split('/');
    const tabName = section === 'seguimiento' ? 'seguimiento' : section === 'diseno' && requestedTab === 'animaciones' ? 'avisos'
      : section === 'sonidos' && requestedTab === 'menus' ? 'marcador' : section === 'pruebas' ? 'pruebas' : requestedTab;
    const pageName = section === 'appearance-heading' ? 'diseno' : section === 'seguimiento' || section === 'pruebas' ? 'dashboard' : section;
    const page = navigation.find(link => link.dataset.nav === pageName)
      ?? navigation[0];
    const changedPage = !page.hasAttribute('aria-current');
    for (const link of navigation) {
      if (link === page) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    }
    for (const view of pages) view.hidden = view.dataset.view !== page.dataset.nav;
    const view = pages.find(view => view.dataset.view === page.dataset.nav);
    const selected = selectTab(view, tabName);
    if (selected) selectTab(el(selected.getAttribute('aria-controls')!), section === 'pruebas' ? requestedTab : requestedSubtab);
    el('screen-title').textContent = page.textContent;
    const showGifs = page.dataset.nav === 'sprites' && selected?.dataset.tab === 'gifs';
    if (showGifs && !gifViewActive && gifNoticeMode) setGifMode(true);
    gifViewActive = showGifs;
    if (changedPage) window.scrollTo(0, 0);
    if (state) { renderTeamPreview(state); renderSoundEditor(); renderDashboardMonitor(); }
  }
  function bindTabs(tablist: Element, tabs: HTMLButtonElement[], activate: (tab: HTMLButtonElement) => void) {
    tabs.forEach(tab => tab.addEventListener('click', () => activate(tab)));
    tablist.addEventListener('keydown', event => {
      if (!(event instanceof KeyboardEvent)) return;
      const current = tabs.indexOf(event.target as HTMLButtonElement);
      if (current < 0) return;
      const index = { ArrowLeft: (current + tabs.length - 1) % tabs.length,
        ArrowRight: (current + 1) % tabs.length, Home: 0, End: tabs.length - 1 }[event.key];
      if (index === undefined) return;
      event.preventDefault();
      tabs[index].focus();
      activate(tabs[index]);
    });
  }
  for (const tablist of document.querySelectorAll('[role=tablist]')) {
    if (tablist.id.startsWith('sound-') || tablist.id === 'gif-type-tabs') continue;
    const tabs = [...tablist.querySelectorAll<HTMLButtonElement>('[data-tab]')];
    const view = tablist.closest<HTMLElement>('[data-view]')!;
    const parentPanel = tablist.closest('[role=tabpanel]');
    const parentTab = parentPanel ? el(parentPanel.getAttribute('aria-labelledby')!).dataset.tab : undefined;
    bindTabs(tablist, tabs, tab => { location.hash = [view.dataset.view, parentTab, tab.dataset.tab].filter(Boolean).join('/'); });
  }
  window.addEventListener('hashchange', navigate);
  navigate();
  const previewSize = new ResizeObserver(entries => {
    for (const entry of entries) {
      const target = entry.target as HTMLElement;
      if (target.id === 'position-preview') renderPositions();
      else target.style.setProperty('--preview-scale', String(entry.contentRect.width / 1280));
    }
  });
  document.querySelectorAll('.preview-stage, #position-preview').forEach(stage => previewSize.observe(stage));
  const message = (text: string, error = false) => {
    const element = el('message');
    clearTimeout(toast);
    element.textContent = text;
    element.dataset.error = String(error);
    element.hidden = false;
    if (!error) toast = setTimeout(() => { element.hidden = true; }, 4200);
  };
  function renderVolume() {
    el('volume-display').textContent = input('sound-volume').value + ' %';
    el('sound-alerts-level').textContent = input('sound-alerts-volume').value + ' %';
    el('sound-menus-level').textContent = input('sound-menus-volume').value + ' %';
  }
  function filterCatalogRows(kind: 'gif' | 'sound') {
    const query = input(kind + '-catalog-search').value;
    const matches = catalogMatcher(query);
    let found = false;
    for (const row of el(kind + '-options').querySelectorAll<HTMLElement>('[data-catalog-name]')) {
      row.hidden = !matches(row.dataset.catalogName ?? '');
      found ||= !row.hidden;
    }
    el(kind + '-catalog-no-results').hidden = !query.trim() || found;
  }
  for (const kind of ['gif', 'sound'] as const) {
    input(kind + '-catalog-search').addEventListener('input', () => filterCatalogRows(kind));
  }
  function readSoundMix(): SoundMix {
    return {
      alerts: input('sound-alerts-enabled').checked, menus: input('sound-menus-enabled').checked,
      alertsVolume: input('sound-alerts-volume').valueAsNumber, menusVolume: input('sound-menus-volume').valueAsNumber,
    };
  }
  async function refreshCatalog() {
    catalog = await call<MediaCatalog>('/media');
    catalogReady = true;
    spriteFingerprint = '';
    if (state) render(state);
  }
  function bindSoundEventTabs(id: string, events: readonly SoundEvent[], selectEvent: (event: SoundEvent) => void) {
    const tablist = el(id);
    const tabs = events.map((soundEvent, index) => {
      const tab = document.createElement('button');
      tab.type = 'button';
      tab.id = 'sound-event-' + soundEvent;
      tab.textContent = soundNames[soundEvent];
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-controls', 'sound-list');
      tab.setAttribute('aria-selected', String(index === 0));
      tab.tabIndex = index === 0 ? 0 : -1;
      return tab;
    });
    tablist.append(...tabs);
    bindTabs(tablist, tabs, tab => {
      if (tab.getAttribute('aria-selected') === 'true') return;
      for (const control of tabs) {
        control.setAttribute('aria-selected', String(control === tab));
        control.tabIndex = control === tab ? 0 : -1;
      }
      selectEvent(events[tabs.indexOf(tab)]);
      renderSoundEditor();
    });
  }
  bindSoundEventTabs('sound-alert-types', noticeTypes, soundEvent => { soundNoticeType = soundEvent as NoticeType; });
  bindSoundEventTabs('sound-menu-types', menuSoundTypes, soundEvent => { soundMenuType = soundEvent as typeof menuSoundTypes[number]; });

  function activeSoundEvent(): SoundEvent {
    return el('sound-menus').hidden ? soundNoticeType : soundMenuType;
  }
  function soundTitle(choice: SoundChoice) {
    return choice.startsWith('tone:') ? tones[choice.slice(5) as Tone].label : choice.slice(5);
  }
  function availableSound(choice: SoundChoice) {
    return choice.startsWith('tone:') || catalog.sounds.includes(choice.slice(5));
  }
  function stopSoundPreview() {
    soundPreviewRun++;
    soundPreviewCue = undefined;
    soundPreviewSource?.stop();
    soundPreviewSource = undefined;
    el('sound-scene').removeAttribute('src');
    el('sound-scene-panel').hidden = true;
  }
  function clearSoundPreview() {
    stopSoundPreview();
    soundPreviewChoice = undefined;
    el('sound-preview-controls').hidden = true;
    el('sound-preview-hint').hidden = false;
  }
  function selectSoundPreview(choice: SoundChoice) {
    stopSoundPreview();
    soundPreviewChoice = choice;
    el('sound-preview-name').textContent = soundTitle(choice);
    el('sound-preview-kind').textContent = choice.startsWith('tone:') ? 'Tono integrado' : 'Archivo del catálogo';
    button('sound-in-context').textContent = el('sound-menus').hidden ? 'En la notificación' : 'En el marcador';
    el('sound-preview-controls').hidden = false;
    el('sound-preview-hint').hidden = true;
    for (const control of el('sound-list').querySelectorAll<HTMLButtonElement>('[data-sound-choice]')) {
      if (control.dataset.soundChoice === choice) control.setAttribute('aria-current', 'true');
      else control.removeAttribute('aria-current');
    }
    if (matchMedia('(max-width: 900px)').matches) el('sound-inspector').scrollIntoView({ block: 'nearest' });
  }
  function renderSoundEditor() {
    const visible = !el('sounds-heading').closest<HTMLElement>('[data-view]')!.hidden && el('sound-general').hidden;
    el('sound-editor').hidden = !el('sound-general').hidden;
    if (!visible) {
      if (soundEditorActive) clearSoundPreview();
      soundEditorActive = false;
      return;
    }
    soundEditorActive = true;
    const soundEvent = activeSoundEvent();
    if (lastSoundEvent !== soundEvent) clearSoundPreview();
    lastSoundEvent = soundEvent;
    if (soundPreviewChoice && !availableSound(soundPreviewChoice)) clearSoundPreview();
    const saved = soundsFor(state.overlay.sounds ?? defaultSounds, soundEvent);
    const fingerprint = JSON.stringify([soundEvent, saved, catalog.sounds, busy]);
    if (soundFingerprint === fingerprint) return;
    soundFingerprint = fingerprint;
    const draft = soundDrafts.get(soundEvent) ?? saved;
    const integrated = (Object.keys(tones) as Tone[]).filter(tone => tone !== 'mute').map(tone => ('tone:' + tone) as SoundChoice);
    const files = catalog.sounds.map(file => ('file:' + file) as SoundChoice);
    const options = [...new Set([...integrated, ...files, ...draft, ...saved])];
    const form = document.createElement('form');
    const group = document.createElement('fieldset');
    const legend = document.createElement('legend');
    legend.textContent = soundNames[soundEvent];
    const heading = document.createElement('h3');
    heading.className = 'catalog-list-heading';
    heading.textContent = legend.textContent;
    heading.setAttribute('aria-hidden', 'true');
    const choices = document.createElement('div');
    choices.className = 'gif-choices';
    for (const choice of options) {
      const row = document.createElement('div');
      row.className = 'gif-choice';
      row.dataset.catalogName = soundTitle(choice);
      const check = document.createElement('input');
      check.type = 'checkbox';
      check.name = 'sound';
      check.value = choice;
      check.checked = draft.includes(choice);
      check.setAttribute('aria-label', 'Usar ' + soundTitle(choice) + ' en ' + soundNames[soundEvent].toLowerCase());
      const preview = document.createElement('button');
      preview.type = 'button';
      preview.dataset.soundChoice = choice;
      preview.textContent = soundTitle(choice) + (availableSound(choice) ? '' : ' (no disponible)');
      preview.disabled = !availableSound(choice);
      if (soundPreviewChoice === choice) preview.setAttribute('aria-current', 'true');
      preview.addEventListener('click', () => selectSoundPreview(choice));
      row.append(check, preview);
      choices.append(row);
    }
    const actions = document.createElement('div');
    actions.className = 'inline';
    const save = document.createElement('button');
    save.type = 'submit';
    save.textContent = 'Guardar sonidos';
    const selected = () => new FormData(form).getAll('sound') as SoundChoice[];
    function update() {
      const choices = selected();
      const dirty = choices.length !== saved.length || choices.some(choice => !saved.includes(choice));
      save.disabled = busy || !dirty || choices.some(choice => !availableSound(choice));
      if (dirty) soundDrafts.set(soundEvent, choices);
      else soundDrafts.delete(soundEvent);
    }
    form.addEventListener('change', update);
    form.addEventListener('submit', event => {
      event.preventDefault();
      const choices = selected();
      void run(async () => {
        const draftAtSubmit = soundDrafts.get(soundEvent);
        const next = await call<PanelState>('/sounds/' + soundEvent, { choices });
        if (soundDrafts.get(soundEvent) === draftAtSubmit) soundDrafts.delete(soundEvent);
        render(next);
        message('Sonidos guardados para ' + soundNames[soundEvent].toLowerCase() + '.');
      });
    });
    actions.append(save);
    group.append(legend, heading, choices, actions);
    form.append(group);
    el('sound-list').setAttribute('aria-labelledby', 'sound-event-' + soundEvent);
    el('sound-options').replaceChildren(form);
    filterCatalogRows('sound');
    update();
  }

  async function preparePanelSound(choice: SoundChoice, volume: number): Promise<() => void> {
    panelAudio ??= new AudioContext();
    const context = panelAudio;
    await context.resume();
    if (choice.startsWith('tone:')) return () => playTone(context, choice.slice(5) as Tone, volume);
    const response = await fetch('/api/panel/media/sounds/' + encodeURIComponent(choice.slice(5)));
    if (!response.ok) throw new Error();
    const buffer = await context.decodeAudioData(await response.arrayBuffer());
    return () => {
      const node = context.createBufferSource();
      const gain = context.createGain();
      node.buffer = buffer;
      gain.gain.value = volume / 100;
      node.connect(gain).connect(context.destination);
      node.addEventListener('ended', () => {
        node.disconnect();
        gain.disconnect();
        if (soundPreviewSource === node) soundPreviewSource = undefined;
      }, { once: true });
      soundPreviewSource = node;
      node.start();
    };
  }
  async function previewSound(inContext: boolean) {
    const choice = soundPreviewChoice;
    if (!choice) return;
    stopSoundPreview();
    const id = String(soundPreviewRun);
    const volume = soundVolume(input('sound-volume').valueAsNumber, readSoundMix(), activeSoundEvent(), true);
    try {
      const play = await preparePanelSound(choice, volume);
      if (id !== String(soundPreviewRun)) return;
      if (!inContext) { play(); return; }
      const draft = visualDirty && !el('appearance').querySelector('input:invalid') ? readAppearance() : undefined;
      soundPreviewCue = { id, play, volume };
      el('sound-scene-panel').hidden = false;
      el('sound-preview-status').textContent = 'Cargando la vista previa…';
      el<HTMLIFrameElement>('sound-scene').src = '/api/panel/sprite-preview?' + new URLSearchParams({
        soundPreview: activeSoundEvent(), cue: id, ...(draft && { appearance: JSON.stringify(draft) }),
      });
      setTimeout(() => {
        if (soundPreviewCue?.id !== id) return;
        soundPreviewCue = undefined;
        el('sound-preview-status').textContent = 'No se pudo iniciar la vista previa.';
      }, 6000);
    } catch {
      if (id === String(soundPreviewRun)) message('El navegador no pudo reproducir este sonido.', true);
    }
  }
  button('sound-listen').addEventListener('click', () => void previewSound(false));
  for (const id of ['sound-in-context', 'sound-replay']) button(id).addEventListener('click', () => void previewSound(true));
  window.addEventListener('message', event => {
    if (event.origin !== location.origin || event.source !== el<HTMLIFrameElement>('sound-scene').contentWindow
        || event.data?.type !== 'koi-sound-preview' || !soundPreviewCue || event.data.cue !== soundPreviewCue.id) return;
    const { play, volume } = soundPreviewCue;
    soundPreviewCue = undefined;
    play();
    el('sound-preview-status').textContent = volume ? 'Vista de ensayo del overlay' : 'Nivel de sonido al 0 %';
  });
  const entryLabel = (entry: Entry) => {
    const same = labels.get(JSON.stringify([entry.name, entry.country])) ?? 0;
    return `${entry.name}${entry.country ? ` · ${entry.country}` : ''}${same > 1 ? ` · participante ${entry.id}` : ''}`;
  };
  function updateList(preset?: string[]) {
    const query = input('search').value.normalize('NFC').toLocaleLowerCase('es').trim();
    const entries = setup?.entries ?? state?.config?.players ?? [];
    const visible = entries.filter(entry => `${entry.name} ${entry.country}`.normalize('NFC').toLocaleLowerCase('es').includes(query));
    const selected = preset ?? players.map(player => player.value);
    players.forEach((player, index) => {
      const preserved = entries.find(entry => String(entry.id) === selected[index])
        ?? state?.config?.players.find(entry => String(entry.id) === selected[index]);
      const values = preserved && !visible.includes(preserved) ? [preserved, ...visible] : visible;
      player.replaceChildren(new Option(index === 0 ? 'Elige un jugador' : 'Sin seleccionar', ''),
        ...values.map(entry => new Option(entryLabel(entry), String(entry.id))));
      player.value = selected[index] ?? '';
    });
  }
  function render(next: PanelState, first = false) {
    const designChanged = state && JSON.stringify(state.appearance) !== JSON.stringify(next.appearance);
    state = next;
    const active = Boolean(next.activeUntil && next.activeUntil > Date.now());
    el('phase').dataset.phase = next.status.phase;
    el('phase').textContent = phases[next.status.phase];
    el('status').textContent = next.status.message;
    el('event-name').hidden = !next.config;
    el('event-name').textContent = next.config ? `${next.config.title} · ${next.config.division}${next.overlay.round ? ` · Ronda ${next.overlay.round}` : ''}` : '';
    const times = [next.status.successAt && `Última consulta válida ${time(next.status.successAt)}`,
      next.status.sourceUpdatedAt && `Publicación de PokéData ${time(next.status.sourceUpdatedAt)}`,
      active && `Caduca a las ${time(next.activeUntil!)}`].filter(Boolean);
    el('sync-info').hidden = !times.length;
    el('sync-info').textContent = times.join(' · ');
    button('toggle').textContent = active ? 'Pausar seguimiento' : 'Iniciar seguimiento';
    button('toggle').disabled = busy || !next.config || (!active && !next.url);
    button('toggle-scoreboard').textContent = next.appearance.scoreboard ? 'Ocultar marcador' : 'Mostrar marcador';
    button('toggle-scoreboard').disabled = busy;
    button('load').disabled = busy || active;
    button('save').disabled = busy || active || !setup;
    input('tournament').disabled = active;
    select('division').disabled = active;
    el('tracking-lock').hidden = !active;
    input('search').disabled = active || !setup;
    players.forEach(player => { player.disabled = active || !setup; });
    input('overlay-url').value = next.url;
    if (!originDirty) input('project-origin').value = next.origin || location.origin;
    renderOriginEditing();
    input('preview-url').value = next.previewUrl;
    for (const id of ['open-live', 'revoke-live']) button(id).disabled = !next.url;
    for (const id of ['preview', 'run-trial', 'stop-trial', 'open-direct-trial', 'copy-direct-trial', 'revoke-preview']) button(id).disabled = !next.previewUrl;
    button('rotate-live').textContent = next.url ? 'Cambiar URL de directo' : 'Crear URL de directo';
    button('rotate-preview').textContent = next.previewUrl ? 'Cambiar URL de ensayo' : 'Crear URL de ensayo';
    button('save-appearance').disabled = busy;
    button('appearance-preview').disabled = !next.previewUrl;
    button('gif-preview').disabled = !next.previewUrl;
    button('save-sounds').disabled = busy;
    if (soundEdit === savedSoundEdit) {
      const sounds = next.overlay.sounds ?? defaultSounds;
      input('sound-enabled').checked = next.appearance.sound;
      input('sound-volume').value = String(sounds.volume);
      const mix = sounds.mix ?? defaultSoundMix;
      input('sound-alerts-enabled').checked = mix.alerts;
      input('sound-menus-enabled').checked = mix.menus;
      input('sound-alerts-volume').value = String(mix.alertsVolume);
      input('sound-menus-volume').value = String(mix.menusVolume);
      renderVolume();
    }
    renderSoundEditor();
    const selected = next.config?.players ?? [];
    const scope = JSON.stringify([next.config?.id, next.config?.division, selected.map(player => player.id)]);
    if (scope !== aliasScope) {
      aliasScope = scope;
      el('alias-fields').hidden = !selected.length;
      el('alias-empty').hidden = Boolean(selected.length);
      el('appearance-aliases').replaceChildren(...selected.map((player, index) => {
        const field = document.createElement('div');
        const label = document.createElement('label');
        const control = document.createElement('input');
        control.id = `visual-alias-${index}`;
        label.htmlFor = control.id;
        label.textContent = player.name;
        control.placeholder = 'Nombre publicado';
        control.maxLength = 32;
        control.value = player.alias;
        field.append(label, control);
        return field;
      }));
    }
    if (!visualDirty) {
      const visual = resolveAppearance(next.appearance);
      for (const key of flagKeys) input(key).checked = visual[key];
      input('hide-scoreboard-during-alert').checked = visual.hideScoreboardDuringAlert;
      input('duration').value = String(visual.duration);
      input('accent').value = visual.color;
      for (const [setting, id] of generalControls) input(id).value = String(visual[setting]);
      input('scoreboard-size').value = String(visual.scoreboardSize);
      input('alert-size').value = String(visual.alertSize);
      select('scoreboard-position').value = visual.scoreboardPosition;
      select('scoreboard-style').value = visual.scoreboardStyle;
      select('score-entrance').value = visual.scoreboardMotion.entrance;
      select('score-exit').value = visual.scoreboardMotion.exit;
      select('score-effect').value = visual.scoreboardMotion.effect;
      input('score-entrance-ms').value = String(visual.scoreboardMotion.entranceMs);
      input('score-exit-ms').value = String(visual.scoreboardMotion.exitMs);
      for (const field of scoreboardFieldKeys) input(`score-field-${field}`).checked = visual.scoreboardFields[field];
      select('alert-position').value = visual.alertPosition;
      for (const [kind, offset] of [['scoreboard', visual.scoreboardOffset], ['alert', visual.alertOffset]] as const) {
        input(`${kind}-offset-x`).value = String(offset.x);
        input(`${kind}-offset-y`).value = String(offset.y);
      }
      select('entrance').value = visual.entrance;
      select('alert-style').value = visual.alertStyle;
      select('alert-layout').value = visual.alertLayout;
      select('alert-exit').value = visual.alertExit;
      select('alert-effect').value = visual.alertEffect;
      input('entrance-ms').value = String(visual.entranceMs);
      input('exit-ms').value = String(visual.exitMs);
      input('alert-gap-ms').value = String(visual.alertGapMs);
      selected.forEach((player, index) => { input(`visual-alias-${index}`).value = player.alias; });
    }
    renderPositions();
    renderSprites(next);
    renderTeamPreview(next);
    renderGifs(next);
    if (designChanged && gifViewActive && gifNoticeMode && !visualDirty) setGifMode(true);
    const cards = next.overlay.cards.map(card => {
      const article = document.createElement('article');
      const title = document.createElement('h3');
      title.textContent = card.selection.alias || card.selection.name;
      const detail = document.createElement('p');
      detail.textContent = [
        next.overlay.round && `Ronda ${next.overlay.round}`, card.record && `Balance ${card.record}`,
        card.missing ? 'Jugador ausente' : card.dropped ? 'Retirado' : card.match ? outcomeLabel[card.match.outcome] : 'Sin cruce publicado',
        card.match?.opponent?.name, card.match?.table && `Mesa ${card.match.table}`,
      ].filter(Boolean).join(' · ');
      article.append(title, detail);
      return article;
    });
    el('cards').replaceChildren(...cards);
    renderOnAirMenus(next);
    renderDashboardMonitor();
    if (first && next.config) {
      input('tournament').value = `https://www.pokedata.ovh/standings2/${next.config.id}`;
      select('division').value = next.config.division;
    }
    for (const { control, field } of urlCopyControls) control.disabled = !field.value.trim();
    const assigned = next.config?.players.map(player => String(player.id)) ?? [];
    if (first || (active && players.some((control, index) => control.value !== (assigned[index] ?? '')))) updateList(assigned);
  }
  function renderDashboardMonitor() {
    const frame = el<HTMLIFrameElement>('dashboard-scene');
    if (el('dashboard-tracking').hidden || el('dashboard-tracking').closest<HTMLElement>('[data-view]')!.hidden) {
      if (frame.hasAttribute('src')) frame.removeAttribute('src');
      dashboardLiveUrl = '';
      dashboardTest = undefined;
      return;
    }
    const hasLive = Boolean(state.url);
    button('dashboard-live').disabled = !dashboardTest;
    for (const id of ['dashboard-team', 'dashboard-history', 'dashboard-alert']) button(id).disabled = false;
    el('dashboard-monitor-mode').textContent = dashboardTest ? 'Ensayo local' : 'Directo';
    el('dashboard-monitor-no-link').hidden = hasLive || Boolean(dashboardTest);
    el('dashboard-stage').hidden = !hasLive && !dashboardTest;
    if (dashboardTest) return;
    if (!hasLive) frame.removeAttribute('src');
    else if (dashboardLiveUrl !== state.url) frame.src = '/api/panel/live-view';
    dashboardLiveUrl = state.url;
  }
  function testDashboardScene(scene: NonNullable<typeof dashboardTest>) {
    dashboardTest = scene;
    dashboardLiveUrl = '';
    const query = new URLSearchParams({ soundPreview: scene, replay: String(++dashboardReplay) });
    el<HTMLIFrameElement>('dashboard-scene').src = '/api/panel/sprite-preview?' + query;
    renderDashboardMonitor();
  }
  button('dashboard-alert').addEventListener('click', () => testDashboardScene(select('dashboard-scenario').value as Scenario));
  button('dashboard-team').addEventListener('click', () => testDashboardScene('team'));
  button('dashboard-history').addEventListener('click', () => testDashboardScene('history'));
  button('dashboard-live').addEventListener('click', () => { dashboardTest = undefined; renderDashboardMonitor(); });
  const dashboardAudio = input('dashboard-menu-audio');
  dashboardAudio.checked = sessionStorage.getItem('koi-dashboard-menu-audio') !== 'off';
  dashboardAudio.addEventListener('change', () => {
    sessionStorage.setItem('koi-dashboard-menu-audio', dashboardAudio.checked ? 'on' : 'off');
    if (!dashboardAudio.checked) {
      soundPreviewSource?.stop();
      el('dashboard-menu-audio-status').hidden = true;
    }
  });
  function prepareDashboardMenuSound(next: ScoreMenu | null) {
    const event = menuSoundEvent(state.overlay.programMenu?.selected ?? null, next);
    if (!event || !dashboardAudio.checked || !state.appearance.sound) return;
    const settings = state.overlay.sounds ?? defaultSounds;
    const volume = soundVolume(settings.volume, settings.mix ?? defaultSoundMix, event);
    const choice = pickSound(soundsFor(settings, event), lastDashboardSound.get(event));
    if (!volume || !choice) return;
    return preparePanelSound(choice, volume).then(play => () => {
      if (!dashboardAudio.checked) return;
      lastDashboardSound.set(event, choice);
      soundPreviewSource?.stop();
      play();
      const status = el('dashboard-menu-audio-status');
      status.textContent = soundNames[event] + ' · ' + soundTitle(choice);
      status.hidden = false;
    }).catch(() => () => message('El menú cambió en directo. El navegador no pudo reproducir su sonido aquí.', true));
  }
  function renderOnAirMenus(next: PanelState) {
    const players = next.config?.players ?? [];
    const selected = next.overlay.programMenu?.selected;
    el('on-air-menus').hidden = players.length === 0;
    const ready = Boolean(next.appearance.scoreboard && next.url);
    el('on-air-help').textContent = ready
      ? 'Abre un menú en la fuente de directo de OBS. Al abrir otro, se cierra el anterior.'
      : 'Muestra el marcador y comprueba que la fuente de directo tiene una URL activa.';
    const fingerprint = JSON.stringify([players, selected]);
    const container = el('on-air-players');
    if (fingerprint !== menusFingerprint) {
      menusFingerprint = fingerprint;
      container.replaceChildren(...players.map(player => {
        const row = document.createElement('div');
        row.className = 'on-air-row';
        const name = document.createElement('strong');
        name.textContent = player.alias || player.name;
        row.append(name);
        for (const [kind, label] of [['team', 'equipo'], ['history', 'historial']] as const) {
          const active = selected?.id === player.id && selected.kind === kind;
          const control = document.createElement('button');
          control.type = 'button';
          control.textContent = `${active ? 'Ocultar' : 'Mostrar'} ${label}`;
          control.setAttribute('aria-label', `${control.textContent} de ${name.textContent}`);
          control.setAttribute('aria-pressed', String(active));
          control.addEventListener('click', () => void run(async () => {
            const selection: ScoreMenu | null = active ? null : { id: player.id, kind };
            const sound = prepareDashboardMenuSound(selection);
            const next = await call<PanelState>('/score-menu', { selected: selection });
            render(next);
            message(active ? 'Menú cerrado en directo.' : 'Menú enviado a la fuente de directo.');
            void sound?.then(play => {
              if (state.overlay.programMenu?.revision === next.overlay.programMenu?.revision) play();
            });
          }));
          row.append(control);
        }
        return row;
      }));
    }
    for (const control of container.querySelectorAll('button')) control.disabled = busy || !ready;
  }
  function readPositionSettings() {
    const offset = (kind: 'scoreboard' | 'alert') => ({
      x: input(`${kind}-offset-x`).valueAsNumber || 0,
      y: input(`${kind}-offset-y`).valueAsNumber || 0,
    });
    return {
      scoreboardPosition: select('scoreboard-position').value as Appearance['scoreboardPosition'],
      alertPosition: select('alert-position').value as Appearance['alertPosition'],
      scoreboardOffset: offset('scoreboard'),
      alertOffset: offset('alert'),
    };
  }
  function renderPositions() {
    const preview = el('position-preview');
    const settings = readPositionSettings();
    const [width, height] = [preview.clientWidth, preview.clientHeight];
    preview.style.setProperty('--map-margin-x', `${Math.max(0, Math.min(15, input('margin-x').valueAsNumber || 0)) * width / 100}px`);
    preview.style.setProperty('--map-margin-y', `${Math.max(0, Math.min(15, input('margin-y').valueAsNumber || 0)) * height / 100}px`);
    preview.dataset.shared = String(sharesPosition(settings) && input('scoreboard').checked && !input('hide-scoreboard-during-alert').checked);
    for (const [id, position, offset] of [['position-score', settings.scoreboardPosition, settings.scoreboardOffset],
      ['position-alert', settings.alertPosition, settings.alertOffset]] as const) {
      const [row, column] = position.split('-');
      const marker = el(id);
      marker.dataset.x = column;
      marker.dataset.y = row;
      marker.style.setProperty('--map-x', `${offset.x * width / 100}px`);
      marker.style.setProperty('--map-y', `${offset.y * height / 100}px`);
      marker.style.opacity = String((input(id === 'position-score' ? 'scoreboard-opacity' : 'alert-opacity').valueAsNumber || 100) / 100);
      marker.hidden = !input(id === 'position-score' ? 'scoreboard' : 'alerts').checked;
    }
  }
  function renderSprites(next: PanelState) {
    const players = next.config?.players ?? [];
    const publishedSource = next.previewUrl || next.url;
    const source = publishedSource ? new URL(publishedSource).pathname : '';
    const versions = new Map(next.overlay.cards.map(card => [card.selection.id, card] as const));
    const scope = next.config && `${next.config.id}:${next.config.division}`;
    const fingerprint = JSON.stringify([source, scope, players, [...versions].map(([id, card]) => [id, card.sprite, card.team, card.teamVideoSlots]), next.media.players]);
    if (spriteFingerprint === fingerprint) return;
    spriteFingerprint = fingerprint;
    el('sprites-empty').hidden = Boolean(players.length);
    el('teams-empty').hidden = Boolean(players.length);
    function spriteRow(kind: 'player' | 'pokemon', id: number, labelText: string, version?: string | null, slot?: number) {
      const row = document.createElement('article');
      row.className = 'sprite-row';
      const category = kind === 'pokemon' ? 'pokemon' : 'players';
      const saved = slot === undefined ? next.media.players[id]?.avatar : next.media.players[id]?.team[slot - 1];
      const thumbnail = document.createElement('div');
      thumbnail.className = 'sprite-preview';
      const legacyUrl = version && source && `${source}/${kind === 'player' ? 'sprite' : kind}/${id}/${slot ? `${slot}/` : ''}${version}`;
      const url = saved ? `/api/panel/media/${category}/${encodeURIComponent(saved)}` : legacyUrl;
      if (url) {
        const video = kind === 'pokemon' && (saved ? /\.webm$/i.test(saved) : versions.get(id)?.teamVideoSlots?.includes(slot!));
        const media = spriteElement(url, saved ?? labelText, video);
        media.addEventListener('error', () => { thumbnail.textContent = 'Vista previa no disponible'; }, { once: true });
        thumbnail.append(media);
      } else thumbnail.textContent = version ? 'Vista previa no disponible' : 'Sin sprite';
      const controlId = `sprite-${kind}-${id}${slot ? `-${slot}` : ''}`;
      const initial = saved || (version ? ':legacy' : '');
      function save(file: string | null) {
        return call<PanelState>('/sprites', { kind, id, scope, slot, file });
      }
      function applied(response: PanelState, file: string | null) {
        render(response);
        message(file ? 'Sprite seleccionado.' : 'Sprite retirado.');
      }
      const controls = document.createElement('div');
      if (kind === 'pokemon') {
        controls.append(pokemonPicker(controlId, labelText, initial, file => {
          void run(async () => {
            const response = await save(file);
            const focused = document.activeElement?.id === controlId;
            applied(response, file);
            if (focused) document.getElementById(controlId)?.focus();
          });
        }));
      } else {
        const label = document.createElement('label');
        const choice = document.createElement('select');
        choice.id = controlId;
        choice.append(new Option('Sin sprite', ''), ...catalog.players.map(name => new Option(name, name)));
        if (initial && !catalog.players.includes(initial)) choice.add(new Option(spriteOptionLabel(initial, catalog.players), initial));
        choice.value = initial;
        label.htmlFor = choice.id;
        label.textContent = labelText;
        controls.append(label, choice);
        choice.addEventListener('change', () => {
          if (busy) { choice.value = initial; return; }
          const file = choice.value || null;
          void run(async () => {
            try { applied(await save(file), file); }
            catch (error) { choice.value = initial; throw error; }
          });
        });
      }
      row.append(thumbnail, controls);
      return row;
    }
    for (const [container, showTeam] of [['sprite-list', false], ['team-list', true]] as const) {
      el(container).replaceChildren(...players.map(player => {
        const group = document.createElement('section');
        group.className = 'sprite-group';
        const heading = document.createElement('h3');
        heading.textContent = player.alias || player.name;
        const card = versions.get(player.id);
        group.append(heading);
        if (showTeam) {
          const team = document.createElement('div');
          team.className = 'sprite-team';
          team.append(...teamSlots.map(slot => spriteRow('pokemon', player.id, `Pokémon ${slot}`, card?.team?.[slot - 1], slot)));
          group.append(team);
        } else group.append(spriteRow('player', player.id, 'Imagen del jugador', card?.sprite));
        return group;
      }));
    }
  }
  function spriteOptionLabel(value: string, files: string[]) {
    if (!value) return 'Sin sprite';
    if (value === ':legacy') return 'Sprite guardado anteriormente';
    return catalogReady && !files.includes(value) ? value + ' (archivo no disponible)' : value;
  }
  function pokemonPicker(id: string, label: string, assigned: string, onSelect: (file: string | null) => void) {
    const field = document.createElement('div');
    const caption = document.createElement('span');
    caption.className = 'pokemon-picker-label';
    caption.id = id + '-label';
    caption.textContent = label;
    const picker = document.createElement('details');
    picker.className = 'pokemon-picker';
    const summary = document.createElement('summary');
    summary.id = id;
    summary.setAttribute('aria-labelledby', caption.id + ' ' + id + '-value');
    const value = document.createElement('span');
    value.id = id + '-value';
    value.textContent = spriteOptionLabel(assigned, catalog.pokemon);
    value.title = value.textContent;
    summary.append(value);
    const panel = document.createElement('div');
    panel.className = 'pokemon-picker-panel';
    const search = document.createElement('input');
    search.type = 'search';
    search.placeholder = 'Nombre o formato';
    search.setAttribute('aria-label', 'Buscar archivos para ' + label);
    search.setAttribute('aria-controls', id + '-files');
    const list = document.createElement('div');
    list.className = 'pokemon-picker-options';
    list.id = id + '-files';
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.setAttribute('role', 'status');
    panel.append(search, empty, list);
    picker.append(summary, panel);
    field.append(caption, picker);
    function filter() {
      const files = catalog.pokemon.filter(catalogMatcher(search.value));
      const blank = !search.value.trim();
      empty.textContent = blank ? 'El catálogo todavía no tiene archivos.' : 'No hay archivos que coincidan.';
      empty.hidden = files.length > 0;
      list.replaceChildren(...(blank ? ['', ...files] : files).map(file => {
        const option = document.createElement('button');
        option.type = 'button';
        option.textContent = spriteOptionLabel(file, catalog.pokemon);
        if (file === assigned) option.setAttribute('aria-current', 'true');
        option.addEventListener('click', () => {
          if (busy) return;
          picker.open = false;
          summary.focus();
          if (file !== assigned) onSelect(file || null);
        });
        return option;
      }));
    }
    picker.addEventListener('toggle', () => {
      if (!picker.open) {
        if (openPokemonPicker === picker) openPokemonPicker = undefined;
        return;
      }
      if (openPokemonPicker && openPokemonPicker !== picker) openPokemonPicker.open = false;
      openPokemonPicker = picker;
      search.value = '';
      filter();
      search.focus();
    });
    search.addEventListener('input', filter);
    picker.addEventListener('keydown', event => {
      if (event.key === 'Escape' && picker.open) {
        event.preventDefault();
        picker.open = false;
        summary.focus();
      }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        const buttons = [...list.querySelectorAll('button')];
        const current = buttons.findIndex(button => button === event.target);
        if (event.target !== search && current === -1) return;
        event.preventDefault();
        const index = event.key === 'ArrowDown' ? current + 1 : current - 1;
        if (index < 0) search.focus();
        else buttons[Math.min(index, buttons.length - 1)]?.focus();
      }
    });
    return field;
  }
  document.addEventListener('pointerdown', event => {
    if (event.target instanceof Node && openPokemonPicker && !openPokemonPicker.contains(event.target)) openPokemonPicker.open = false;
  });
  function updateGifAssignments(next: PanelState) {
    const control = document.getElementById('gif-assignments');
    if (!control || !gifPreviewFile) return;
    const file = gifPreviewFile;
    control.textContent = noticeTypes.filter(type => next.media.gifs[type]?.includes(file))
      .map(type => noticeNames[type]).join(', ') || 'Sin asignar';
  }
  function showSpriteScene(kind: 'team' | 'gif', query: Record<string, string>) {
    const url = '/api/panel/sprite-preview?' + new URLSearchParams(query);
    el<HTMLIFrameElement>(`${kind}-scene`).src = url;
    el<HTMLAnchorElement>(`${kind}-expand`).href = url;
  }
  function renderTeamPreview(next: PanelState) {
    const players = next.config?.players ?? [];
    const enabled = players.length > 0 && !el('sprites-teams').hidden && !el('sprites-teams').closest<HTMLElement>('[data-view]')!.hidden;
    el('team-inspector').hidden = !players.length;
    if (!enabled) {
      if (teamSceneVersion) {
        el('team-scene').removeAttribute('src');
        teamSceneVersion = '';
      }
      return;
    }
    const field = select('team-preview-player');
    const selected = players.find(player => String(player.id) === field.value) ?? players[0];
    const openTeam = select('team-preview-view').value === 'team' ? '1' : '0';
    const version = JSON.stringify([players, selected.id, openTeam, next.appearance, next.overlay.cards, next.media.players]);
    if (teamSceneVersion === version) return;
    teamSceneVersion = version;
    field.replaceChildren(...players.map(player => new Option(player.alias || player.name, String(player.id))));
    field.value = String(selected.id);
    showSpriteScene('team', { player: field.value, openTeam });
  }
  for (const id of ['team-preview-player', 'team-preview-view']) {
    select(id).addEventListener('change', () => { if (state) renderTeamPreview(state); });
  }
  function setGifMode(inNotice: boolean) {
    gifNoticeMode = inNotice;
    button('gif-file-mode').setAttribute('aria-pressed', String(!inNotice));
    button('gif-notice-mode').setAttribute('aria-pressed', String(inNotice));
    el('gif-notice-preview').hidden = !inNotice;
    const figure = el('gif-inspector-content').querySelector<HTMLElement>('.gif-frame');
    if (figure) figure.hidden = inNotice;
    if (inNotice && gifPreviewFile) {
      const draft = visualDirty && state && !el('appearance').querySelector('input:invalid') ? readAppearance() : undefined;
      el('gif-notice-caption').textContent = `${noticeNames[currentGifType]} · ${draft ? 'Diseño sin guardar' : 'Diseño guardado'}`;
      showSpriteScene('gif', { gif: gifPreviewFile, type: currentGifType, replay: String(++gifReplay),
        ...(draft && { appearance: JSON.stringify(draft) }) });
    } else el('gif-scene').removeAttribute('src');
  }
  button('gif-file-mode').addEventListener('click', () => setGifMode(false));
  for (const id of ['gif-notice-mode', 'gif-replay']) button(id).addEventListener('click', () => setGifMode(true));
  const gifTabs = noticeTypes.map(type => {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.id = `gif-type-${type}`;
    tab.dataset.noticeType = type;
    tab.textContent = noticeNames[type];
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-controls', 'gif-list');
    tab.setAttribute('aria-selected', String(type === currentGifType));
    tab.tabIndex = type === currentGifType ? 0 : -1;
    return tab;
  });
  el('gif-type-tabs').append(...gifTabs);
  bindTabs(el('gif-type-tabs'), gifTabs, tab => {
    const type = tab.dataset.noticeType as NoticeType;
    if (type === currentGifType) return;
    currentGifType = type;
    for (const control of gifTabs) {
      control.setAttribute('aria-selected', String(control === tab));
      control.tabIndex = control === tab ? 0 : -1;
    }
    el('gif-list').setAttribute('aria-labelledby', tab.id);
    clearGifPreview('Elige un archivo para ver el GIF y sus datos.');
    if (state) renderGifs(state);
  });
  function clearGifPreview(value: string) {
    gifPreviewFile = undefined;
    el('gif-view-controls').hidden = true;
    setGifMode(false);
    const hint = document.createElement('p');
    hint.className = 'muted';
    hint.textContent = value;
    el('gif-inspector-content').replaceChildren(hint);
  }
  function previewGif(file: string) {
    gifPreviewFile = file;
    const inspector = el('gif-inspector-content');
    const figure = document.createElement('div');
    figure.className = 'gif-frame';
    const image = document.createElement('img');
    image.alt = `Vista previa de ${file}`;
    image.hidden = true;
    const status = document.createElement('p');
    status.className = 'muted';
    status.setAttribute('role', 'status');
    status.textContent = 'Cargando GIF…';
    figure.append(image, status);
    const title = document.createElement('p');
    title.className = 'gif-filename';
    title.textContent = file;
    const details = document.createElement('dl');
    const values = ['Dimensiones', 'Tamaño del archivo', 'Asignado a'].map(name => {
      const term = document.createElement('dt');
      term.textContent = name;
      const value = document.createElement('dd');
      value.textContent = '—';
      details.append(term, value);
      return value;
    });
    const [dimensions, size, assignments] = values;
    assignments.id = 'gif-assignments';
    inspector.replaceChildren(figure, title, details);
    el('gif-view-controls').hidden = false;
    setGifMode(gifNoticeMode);
    updateGifAssignments(state);
    el('gif-list').querySelectorAll<HTMLButtonElement>('[data-preview-file]').forEach(control => {
      if (control.dataset.previewFile === file) control.setAttribute('aria-current', 'true');
      else control.removeAttribute('aria-current');
    });
    const url = `/api/panel/media/gifs/${encodeURIComponent(file)}`;
    image.addEventListener('load', () => {
      dimensions.textContent = `${image.naturalWidth} × ${image.naturalHeight} px`;
      image.hidden = false;
      status.textContent = '';
      status.hidden = true;
    }, { once: true });
    image.addEventListener('error', () => { status.textContent = 'No se pudo abrir este GIF.'; }, { once: true });
    image.src = url;
    void fetch(url, { method: 'HEAD' }).then(response => {
      const length = Number(response.headers.get('Content-Length'));
      if (!response.ok || !length) return;
      const unit = length >= 1_000_000 ? 'megabyte' : 'kilobyte';
      size.textContent = new Intl.NumberFormat('es', { style: 'unit', unit, maximumFractionDigits: 2 })
        .format(length / (unit === 'megabyte' ? 1_000_000 : 1000));
    }).catch(() => {});
    if (matchMedia('(max-width: 900px)').matches) el('gif-inspector').scrollIntoView({ block: 'nearest' });
  }
  function renderGifs(next: PanelState) {
    const type = currentGifType;
    const saved = next.media.gifs[type] ?? [];
    const fingerprint = JSON.stringify([type, catalog.gifs, saved, next.previewUrl]);
    updateGifAssignments(next);
    if (fingerprint === gifFingerprint) return;
    gifFingerprint = fingerprint;
    el('gif-empty').hidden = Boolean(catalog.gifs.length);
    if (gifPreviewFile && !catalog.gifs.includes(gifPreviewFile)) {
      clearGifPreview('El archivo ya no está en el catálogo.');
    }
    el('gif-options').replaceChildren(...renderGifForm(next, type, saved));
    filterCatalogRows('gif');
  }
  function renderGifForm(next: PanelState, type: NoticeType, saved: string[]) {
    const draft = gifDrafts.get(type) ?? saved;
    const recommended = defaultNoticeGifs[type]?.filter(file => catalog.gifs.includes(file)) ?? [];
    const options = [...new Set([...recommended, ...saved, ...draft, ...catalog.gifs])];
    if (!options.length) return [];
    const form = document.createElement('form');
    const group = document.createElement('fieldset');
    const legend = document.createElement('legend');
    legend.textContent = noticeNames[type];
    const heading = document.createElement('h3');
    heading.className = 'catalog-list-heading';
    heading.textContent = legend.textContent;
    heading.setAttribute('aria-hidden', 'true');
    const choices = document.createElement('div');
    choices.className = 'gif-choices';
    for (const file of options) {
      const row = document.createElement('div');
      row.className = 'gif-choice';
      row.dataset.catalogName = file;
      const check = document.createElement('input');
      check.type = 'checkbox';
      check.name = 'gif';
      check.value = file;
      check.checked = draft.includes(file);
      check.setAttribute('aria-label', `Usar ${file} en ${noticeNames[type].toLowerCase()}`);
      if (catalog.gifs.includes(file)) {
        const preview = document.createElement('button');
        preview.type = 'button';
        preview.dataset.previewFile = file;
        preview.textContent = file;
        preview.setAttribute('aria-label', `Previsualizar ${file}`);
        if (gifPreviewFile === file) preview.setAttribute('aria-current', 'true');
        preview.addEventListener('click', () => previewGif(file));
        row.append(check, preview);
      } else {
        const unavailable = document.createElement('span');
        unavailable.textContent = `${file} (no disponible)`;
        row.append(check, unavailable);
      }
      choices.append(row);
    }
    const actions = document.createElement('div');
    actions.className = 'inline';
    const save = document.createElement('button');
    save.type = 'submit';
    save.textContent = 'Guardar GIFs';
    save.setAttribute('aria-label', `Guardar GIFs de ${noticeNames[type].toLowerCase()}`);
    const test = document.createElement('button');
    test.type = 'button';
    test.textContent = 'Enviar al ensayo';
    test.setAttribute('aria-label', `Probar GIFs de ${noticeNames[type].toLowerCase()}`);
    function selected() { return new FormData(form).getAll('gif').map(String); }
    function update() {
      const files = selected();
      const dirty = files.length !== saved.length || files.some(file => !saved.includes(file));
      save.disabled = !dirty || files.some(file => !catalog.gifs.includes(file));
      test.disabled = dirty || !next.previewUrl || !saved.some(file => catalog.gifs.includes(file));
      if (dirty) gifDrafts.set(type, files);
      else gifDrafts.delete(type);
    }
    form.addEventListener('change', update);
    form.addEventListener('submit', event => {
      event.preventDefault();
      const files = selected();
      const draftAtSubmit = gifDrafts.get(type);
      void run(async () => {
        const response = await call<PanelState>('/notice-gifs', { type, files });
        if (gifDrafts.get(type) === draftAtSubmit) gifDrafts.delete(type);
        render(response);
        message('GIFs guardados para este aviso.');
      });
    });
    test.addEventListener('click', () => void run(async () => {
      await call('/demo', { scenario: type });
      message('Aviso enviado a la fuente de ensayo.');
    }));
    actions.append(save, test);
    group.append(legend, heading, choices, actions);
    form.append(group);
    update();
    return [form];
  }
  async function run(action: () => Promise<void>) {
    if (busy) return;
    busy = true;
    revision++;
    if (state) render(state);
    try { await action(); }
    catch (error) { message((error as Error).message, true); }
    finally { busy = false; if (state) render(state); }
  }
  async function refresh(first = false) {
    const before = revision;
    try {
      const next = await call<PanelState>();
      if (before === revision && !busy) render(next, first);
    } catch {
      if (location.pathname === '/panel') message('No se pudo actualizar el panel. Se volverá a intentar.', true);
    }
  }
  function clearSetup() {
    setup = null;
    labels.clear();
    el('tournament-info').hidden = true;
    updateList();
    if (state) render(state);
  }
  input('tournament').addEventListener('input', clearSetup);
  select('division').addEventListener('change', clearSetup);
  input('search').addEventListener('input', () => updateList());
  button('load').addEventListener('click', () => void run(async () => {
    el('tournament-info').hidden = false;
    el('tournament-info').textContent = 'Cargando jugadores de PokéData…';
    const requested = input('tournament').value;
    const division = select('division').value as Division;
    let received: Setup;
    try { received = await call<Setup>('/inspect', { url: requested, division }); }
    catch (error) { clearSetup(); throw error; }
    if (requested !== input('tournament').value || division !== select('division').value) return;
    setup = received;
    labels.clear();
    for (const entry of setup.entries) {
      const key = JSON.stringify([entry.name, entry.country]);
      labels.set(key, (labels.get(key) ?? 0) + 1);
    }
    select('division').value = setup.tournament.division;
    el('tournament-info').textContent = `${setup.title} · ${setup.entries.length} jugadores`;
    input('search').value = '';
    const same = state.config?.id === setup.tournament.id && state.config.division === setup.tournament.division;
    updateList(same ? state.config?.players.map(player => String(player.id)) : []);
  }));
  el('configuration').addEventListener('submit', event => {
    event.preventDefault();
    void run(async () => {
      if (!setup) return;
      const config: Config = {
        ...setup.tournament, title: setup.title,
        players: players.flatMap(player => {
          const entry = setup?.entries.find(item => String(item.id) === player.value);
          const same = state.config?.id === setup?.tournament.id && state.config?.division === setup?.tournament.division;
          return entry ? [{ ...entry, alias: (same && state.config?.players.find(item => item.id === entry.id)?.alias) || '' }] : [];
        }),
        duration: state.appearance.duration, color: state.appearance.color, sound: state.appearance.sound,
      };
      if (!players[0].value) throw new Error('Elige al menos el primer jugador.');
      render(await call<PanelState>('/setup', config));
      message('Configuración guardada.');
    });
  });
  let editRevision = 0;
  function editAppearance() { visualDirty = true; editRevision++; renderPositions(); }
  function readAppearance(): Appearance {
    return {
      ...readPositionSettings(),
      marginX: input('margin-x').valueAsNumber, marginY: input('margin-y').valueAsNumber,
      scoreboardOpacity: input('scoreboard-opacity').valueAsNumber, alertOpacity: input('alert-opacity').valueAsNumber,
      scoreboard: input('scoreboard').checked, alerts: input('alerts').checked, sound: state.appearance.sound,
      hideScoreboardDuringAlert: input('hide-scoreboard-during-alert').checked,
      scoreboardStyle: select('scoreboard-style').value as Appearance['scoreboardStyle'],
      scoreboardMotion: {
        entrance: select('score-entrance').value as Appearance['scoreboardMotion']['entrance'],
        exit: select('score-exit').value as Appearance['scoreboardMotion']['exit'],
        effect: select('score-effect').value as Appearance['scoreboardMotion']['effect'],
        entranceMs: input('score-entrance-ms').valueAsNumber, exitMs: input('score-exit-ms').valueAsNumber,
      },
      scoreboardFields: Object.fromEntries(scoreboardFieldKeys.map(field => [field, input(`score-field-${field}`).checked])) as Appearance['scoreboardFields'],
      opponent: input('opponent').checked, table: input('table').checked, record: input('record').checked,
      entrance: select('entrance').value as Appearance['entrance'],
      alertStyle: select('alert-style').value as Appearance['alertStyle'],
      alertLayout: select('alert-layout').value as Appearance['alertLayout'],
      alertExit: select('alert-exit').value as Appearance['alertExit'],
      alertEffect: select('alert-effect').value as Appearance['alertEffect'],
      entranceMs: input('entrance-ms').valueAsNumber, exitMs: input('exit-ms').valueAsNumber,
      alertGapMs: input('alert-gap-ms').valueAsNumber,
      scoreboardSize: input('scoreboard-size').valueAsNumber, alertSize: input('alert-size').valueAsNumber,
      duration: input('duration').valueAsNumber, color: input('accent').value,
    };
  }
  el('appearance').addEventListener('input', editAppearance);
  for (const control of document.querySelectorAll<HTMLButtonElement>('[data-reset-offset]')) {
    control.addEventListener('click', () => {
      input(`${control.dataset.resetOffset}-offset-x`).value = '0';
      input(`${control.dataset.resetOffset}-offset-y`).value = '0';
      editAppearance();
    });
  }
  el('appearance').addEventListener('submit', event => {
    event.preventDefault();
    const invalid = el('appearance').querySelector<HTMLInputElement>('input:invalid');
    if (invalid) {
      const panel = invalid.closest<HTMLElement>('[role=tabpanel]')!;
      const tab = el(panel.getAttribute('aria-labelledby')!);
      location.hash = `diseno/${tab.dataset.tab}`;
      navigate();
      invalid.reportValidity();
      return;
    }
    void run(async () => {
      const before = editRevision;
      const appearance = readAppearance();
      const aliases = state.config?.players.map((player, index) => ({ id: player.id, alias: input(`visual-alias-${index}`).value }));
      const next = await call<PanelState>('/appearance', { appearance, aliases });
      if (before === editRevision) visualDirty = false;
      render(next);
      message('Diseño aplicado al overlay.');
    });
  });
  el('sound-settings').addEventListener('input', () => { soundEdit++; renderVolume(); });
  el('sound-settings').addEventListener('submit', event => {
    event.preventDefault();
    void run(async () => {
      const editing = soundEdit;
      const next = await call<PanelState>('/sounds/volume', {
        enabled: input('sound-enabled').checked, volume: input('sound-volume').valueAsNumber, mix: readSoundMix(),
      });
      savedSoundEdit = editing;
      render(next);
      message('Ajustes generales de sonido aplicados.');
    });
  });
  for (const id of ['refresh-sprites', 'refresh-sounds']) button(id).addEventListener('click', () => void run(async () => {
    await refreshCatalog();
    message('Catálogo actualizado.');
  }));
  button('toggle').addEventListener('click', () => void run(async () => {
    render(await call<PanelState>('/tracking', { active: !state.activeUntil || state.activeUntil <= Date.now() }));
  }));
  button('toggle-scoreboard').addEventListener('click', () => void run(async () => {
    const visible = !state.appearance.scoreboard;
    const next = await call<PanelState>('/scoreboard', { visible });
    input('scoreboard').checked = visible;
    render(next);
    message(visible ? 'Marcador visible en OBS.' : 'Marcador oculto en OBS.');
  }));
  function selectedTrial(): TrialPreset {
    if (!el('trial-alerts').hidden) return select('scenario').value as TrialPreset;
    if (!el('trial-scoreboard').hidden) return select('trial-board-preset').value as TrialPreset;
    if (!el('trial-menus').hidden) return select('trial-menu-preset').value as TrialPreset;
    return 'conexion';
  }
  function directTrialUrl(withControls = false) {
    const url = new URL(state.previewUrl);
    url.searchParams.set('ensayo', selectedTrial());
    if (withControls) url.searchParams.set('controles', '1');
    return url.href;
  }
  button('run-trial').addEventListener('click', () => void run(async () => {
    await call('/demo/controls', { test: selectedTrial() });
    message('Prueba enviada a la fuente.');
  }));
  button('stop-trial').addEventListener('click', () => void run(async () => {
    await call('/demo/controls', { stop: true });
    message('Prueba detenida.');
  }));
  button('logout').addEventListener('click', () => void run(async () => {
    await api('/api/logout', {});
    location.assign('/');
  }));
  function renderOriginEditing() {
    button('save-project-origin').disabled = !state || busy || !originDirty || input('project-origin').type === 'password';
    button('reset-project-origin').disabled = !state || busy;
  }
  for (const toggle of document.querySelectorAll<HTMLButtonElement>('[data-url-target]')) {
    toggle.addEventListener('click', () => {
      const field = input(toggle.dataset.urlTarget!);
      const revealed = field.type === 'password';
      field.type = revealed ? 'text' : 'password';
      toggle.dataset.revealed = String(revealed);
      const label = (revealed ? 'Ocultar ' : 'Mostrar ') + toggle.dataset.urlLabel;
      toggle.title = label;
      toggle.setAttribute('aria-label', label);
      if (field.id === 'project-origin') {
        field.readOnly = !revealed;
        renderOriginEditing();
        if (revealed) field.focus();
      }
    });
  }
  input('project-origin').addEventListener('input', () => {
    originDirty = true;
    originEdit++;
    renderOriginEditing();
  });
  const saveOverlayOrigin = (origin: string | null) => run(async () => {
    const revision = originEdit;
    const next = await call<PanelState>('/overlay-origin', { origin });
    if (originEdit === revision) originDirty = false;
    render(next);
    message('URL base guardada. Los enlaces de OBS y pruebas ya usan esa dirección.');
  });
  el('project-origin-form').addEventListener('submit', event => {
    event.preventDefault();
    if (!button('save-project-origin').disabled) void saveOverlayOrigin(input('project-origin').value.trim());
  });
  button('reset-project-origin').addEventListener('click', () => void saveOverlayOrigin(null));
  const copy = (value: string) => run(async () => { await navigator.clipboard.writeText(value); message('Copiado al portapapeles.'); });
  for (const { control, field } of urlCopyControls) {
    field.addEventListener('input', () => { control.disabled = !field.value.trim(); });
    control.addEventListener('click', () => void copy(field.value.trim()));
  }
  button('copy-direct-trial').addEventListener('click', () => { if (state.previewUrl) void copy(directTrialUrl()); });
  button('open-direct-trial').addEventListener('click', () => {
    if (state.previewUrl) window.open(directTrialUrl(true), '_blank', 'noopener,noreferrer');
  });
  button('open-live').addEventListener('click', () => { if (state.url) window.open(state.url, '_blank', 'noopener,noreferrer'); });
  button('preview').addEventListener('click', () => { if (state.previewUrl) window.open(state.previewUrl, '_blank', 'noopener,noreferrer'); });
  button('appearance-preview').addEventListener('click', () => button('preview').click());
  button('gif-preview').addEventListener('click', () => button('preview').click());
  for (const kind of ['live', 'preview']) {
    for (const action of ['rotate', 'revoke']) button(`${action}-${kind}`).addEventListener('click', () => void run(async () => {
      const existing = kind === 'live' ? state.url : state.previewUrl;
      if (existing && !window.confirm('El enlace actual dejará de funcionar en OBS. ¿Continuar?')) return;
      render(await call<PanelState>('/links', { kind, action }));
      message(action === 'revoke' ? 'Enlace revocado.' : 'Nuevo enlace generado.');
    }));
  }
  button('diagnostics').addEventListener('click', () => void copy(JSON.stringify({
    phase: state.status.phase, lastCheck: state.status.checkedAt,
    lastSuccess: state.status.successAt, sourceUpdated: state.status.sourceUpdatedAt,
  }, null, 2)));
  void refresh(true);
  void refreshCatalog().catch(() => {});
  setInterval(() => { if (!busy) void refresh(); }, 4000);
}

if (document.getElementById('login')) bindLogin();
if (document.getElementById('configuration')) bindPanel();
