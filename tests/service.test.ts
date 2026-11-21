import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { createService } from '../src/server.ts';
import { normalize, tournamentFrom } from '../src/pokedata.ts';
import { reconcile } from '../src/state.ts';
import { defaultAppearance, resolveAppearance } from '../src/appearance.ts';
import { defaultSoundMix, defaultSounds, menuSoundEvent, pickSound, soundsFor, soundVolume } from '../src/sounds.ts';
import { pickNoticeGif } from '../src/media-types.ts';
import type { Config } from '../src/model.ts';

const url = 'https://www.pokedata.ovh/standings2/1000088';
const source = (result = -1) => normalize({
  tournament: { title: 'Torneo de prueba' },
  standings: { division: 'Masters', players: [
    { i: 9, n: 'Álex', c: 'ES', s: [result === 3 ? 1 : 0, 0, 0], r: [[55, result, 20]] },
    { i: 31, n: 'Sam', c: 'IT', s: [0, 0, 0], r: [[42, -1, 21]] },
    { i: 42, n: 'Dana', c: 'FR', s: [0, 0, 0], r: [[31, -1, 21]] },
    { i: 55, n: 'Rival', c: 'BR', s: [0, result === 3 ? 1 : 0, 0], r: [[9, result === 3 ? 0 : -1, 20]] },
  ] },
}, 'Masters');
const settings: Config = {
  ...tournamentFrom(url, 'Masters'), title: 'Torneo de prueba', duration: 2, sound: false, color: '#70efd0',
  players: [{ id: 9, name: 'Álex', country: 'ES', alias: 'Álex' }, { id: 31, name: 'Sam', country: 'IT', alias: 'Sam' }],
};

test('interpreta la identidad del rival por ID y mantiene el resultado por jugador y ronda', () => {
  assert.equal(pickNoticeGif([], undefined), undefined);
  assert.equal(pickNoticeGif(['uno.gif'], 'uno.gif'), 'uno.gif');
  assert.equal(pickNoticeGif(['uno.gif', 'dos.gif'], 'uno.gif', () => 0), 'dos.gif');
  assert.equal(pickNoticeGif(['uno.gif', 'dos.gif', 'tres.gif'], 'dos.gif', () => .9), 'tres.gif');
  assert.deepEqual(soundsFor(defaultSounds, 'team'), []);
  assert.deepEqual(soundsFor(defaultSounds, 'win'), ['tone:classic']);
  assert.equal(pickSound(['tone:rise', 'tone:pulse'], 'tone:rise', () => 0), 'tone:pulse');
  assert.equal(menuSoundEvent({ id: 9, kind: 'team' }, null), 'team-close');
  assert.equal(menuSoundEvent(null, { id: 9, kind: 'history' }), 'history');
  assert.equal(soundVolume(60, { ...defaultSoundMix, alertsVolume: 50 }, 'win'), 30);
  assert.equal(soundVolume(60, { ...defaultSoundMix, menus: false }, 'team-close'), 0);
  assert.equal(soundVolume(60, { ...defaultSoundMix, menus: false }, 'team-close', true), 60);
  const legacy = resolveAppearance({ opponent: false, scoreboard: false, table: false });
  assert.equal(legacy.scoreboardStyle, 'koi');
  assert.equal(legacy.scoreboard, false);
  assert.equal(legacy.hideScoreboardDuringAlert, false);
  assert.deepEqual(legacy.scoreboardOffset, { x: 0, y: 0 });
  assert.deepEqual(legacy.alertOffset, { x: 0, y: 0 });
  assert.equal(legacy.scoreboardOpacity, 100);
  assert.equal(legacy.scoreboardMotion.entrance, 'none');
  assert.equal(legacy.marginX, 3.5);
  assert.equal(legacy.scoreboardFields.opponent, false);
  assert.equal(legacy.scoreboardFields.table, false);
  const before = reconcile(settings, source(), null);
  assert.equal(before.notices.length, 0);
  assert.equal(before.state.cards[0].match?.opponent?.name, 'Rival');
  const after = reconcile(settings, source(3), before.next);
  assert.equal(after.notices.length, 1);
  assert.equal(after.notices[0].outcome, 'win');
  assert.equal(after.state.cards[1].match?.outcome, 'pending');
  assert.equal(reconcile(settings, source(3), after.next).notices.length, 0);
  assert.equal(reconcile(settings, source(1), after.next).notices[0].kind, 'correction');
  assert.throws(() => tournamentFrom('https://pokedata.ovh.example/standings2/1000088', 'Masters'));
  assert.throws(() => normalize({ tournament: { title: 'x' }, standings: { division: 'Masters' } }, 'Masters'));
});

test('panel privado, consultas compartidas, SSE aislado y revocación persistente', { timeout: 12_000 }, async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'koi-test-'));
  const mediaRoot = path.join(folder, '.media');
  const pixel = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/f3sAAAAASUVORK5CYII=';
  const gif = Buffer.from('47494638396101000100800000000000ffffff2c00000000010001000002024401003b', 'hex');
  for (const [category, file] of [['players', 'jugador.png'], ['pokemon', 'pokemon.png'], ['pokemon', 'animado.gif'], ['gifs', 'uno.gif'],
    ['gifs', 'dos.gif'], ['gifs', 'imagen.png'], ['sounds', 'tono.wav']]) {
    await mkdir(path.join(mediaRoot, category), { recursive: true });
    await writeFile(path.join(mediaRoot, category, file), file.endsWith('.gif') ? gif : Buffer.from(pixel, 'base64'));
  }
  const codes = { streamer: 'example-private-code-AAAAAAAAAAAAAAAAAAAA', other: 'example-private-code-BBBBBBBBBBBBBBBBBBBB' };
  let result = -1;
  let calls = 0;
  let fail = false;
  const reading = async () => {
    calls++;
    if (fail) throw new Error('Error de fuente simulado.');
    return { snapshot: source(result), sourceUpdatedAt: null };
  };
  const http = createServer();
  http.listen(0, '127.0.0.1');
  await once(http, 'listening');
  const address = http.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const pagesOrigin = 'https://fibanezv.github.io';
  const options = { origin, pagesOrigin, root: process.cwd(), mediaRoot, dataPath: path.join(folder, 'tests.sqlite'), codes, load: reading, intervalMs: 100 };
  let service = createService(options);
  http.on('request', service.app);
  const get = (route: string, session = '') => fetch(new URL(route, origin), { headers: { cookie: session } });
  const post = (route: string, data: unknown, session = '', requestOrigin = origin) => fetch(new URL(route, origin), {
    method: 'POST', headers: { origin: requestOrigin, cookie: session, 'content-type': 'application/json' }, body: JSON.stringify(data),
  });
  const access = async (code: string) => {
    const answer = await post('/api/login', { code });
    assert.equal(answer.status, 204);
    return answer.headers.get('set-cookie')!.split(';')[0];
  };
  const open = async (link: string) => {
    const response = await get(link + '/events');
    assert.equal(response.status, 200);
    return response.body!.pipeThrough(new TextDecoderStream()).getReader();
  };
  async function until(check: () => Promise<boolean>) {
    for (let attempt = 0; attempt < 40; attempt++) {
      if (await check()) return;
      await delay(50);
    }
    assert.fail('La condición no se cumplió');
  }

  try {
    assert.equal((await get('/api/panel')).status, 401);
    assert.equal((await post('/api/login', { code: codes.streamer }, '', 'https://example.org')).status, 403);
    const session = await access(codes.streamer);
    const other = await access(codes.other);
    const preflight = await fetch(origin + '/api/panel/scoreboard', { method: 'OPTIONS', headers: {
      Origin: pagesOrigin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type',
    } });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), pagesOrigin);
    assert.match(preflight.headers.get('access-control-allow-headers')!, /Authorization/);
    const pagesLogin = await post('/api/login', { code: codes.streamer }, '', pagesOrigin);
    assert.equal(pagesLogin.status, 200);
    assert.equal(pagesLogin.headers.get('set-cookie'), null);
    const token = (await pagesLogin.json()).token;
    const pagesHeaders = { origin: pagesOrigin, authorization: `Bearer ${token}` };
    const fromPages = (route: string, method = 'GET') => fetch(origin + route, { method, headers: pagesHeaders });
    const pagesPanel = await fromPages('/api/panel');
    assert.equal(pagesPanel.status, 200);
    const { url: pagesOverlay } = await pagesPanel.json();
    const spriteHeaders = await fromPages('/api/panel/media/pokemon/Garchomp_HOME.webm', 'HEAD');
    assert.equal(spriteHeaders.headers.get('content-type'), 'video/webm');
    const pagesEvents = await fromPages(new URL(pagesOverlay).pathname + '/events');
    assert.equal(pagesEvents.headers.get('access-control-allow-origin'), pagesOrigin);
    assert.match(pagesEvents.headers.get('content-type')!, /text\/event-stream/);
    await pagesEvents.body?.cancel();
    const fromUntrustedOrigin = await fetch(origin + '/api/panel', { headers: { ...pagesHeaders, origin: 'https://otro.example' } });
    assert.equal(fromUntrustedOrigin.status, 401);
    assert.equal(fromUntrustedOrigin.headers.get('access-control-allow-origin'), null);
    assert.equal((await fromPages('/api/logout', 'POST')).status, 204);
    assert.equal((await fromPages('/api/panel')).status, 401);
    assert.equal((await get('/api/panel/media')).status, 401);
    assert.equal((await get('/api/panel/live-view')).status, 401);
    assert.equal((await get('/api/panel/live-view/source')).status, 401);
    for (const route of ['/demo', '/demo/media/pokemon/Garchomp_HOME.webm', '/demo/media/gifs/new_battle_01.gif']) {
      assert.equal((await get(route)).status, 404);
    }
    assert.equal((await post('/api/panel/demo', { scenario: 'win' })).status, 401);
    const catalog = await (await get('/api/panel/media', session)).json();
    assert.equal(catalog.sounds.filter((file: string) => file.endsWith('.mp3')).length, 13);
    const mp3 = await get('/api/panel/media/sounds/pokemon-battle-win.mp3', session);
    assert.equal(mp3.headers.get('content-type'), 'audio/mpeg');
    await mp3.arrayBuffer();
    assert.ok(catalog.players.includes('icono_riopaser.jpg'));
    assert.ok(catalog.players.includes('icono_pokealex.png'));
    for (const [file, mime] of [['pokemon.png', 'image/png'], ['animado.gif', 'image/gif'], ['Garchomp_HOME.webm', 'video/webm']]) {
      assert.ok(catalog.pokemon.includes(file), `El catálogo incluye ${file}`);
      const asset = await get(`/api/panel/media/pokemon/${file}`, session);
      assert.equal(asset.status, 200);
      assert.equal(asset.headers.get('content-type'), mime);
      await asset.arrayBuffer();
    }
    assert.deepEqual(catalog.gifs, ['dos.gif', 'draw_01.gif', 'free_pass_01.gif', 'lose_01.gif', 'lose_02.gif',
      'lose_03.gif', 'lose_04.gif', 'lose_05.gif', 'lose_06.gif', 'new_battle_01.gif', 'uno.gif',
      'win_01.gif', 'win_02.gif', 'win_03.gif']);
    await writeFile(path.join(mediaRoot, 'pokemon', 'nuevo Pokémon.png'), Buffer.from(pixel, 'base64'));
    assert.ok((await (await get('/api/panel/media', session)).json()).pokemon.includes('nuevo Pokémon.png'));
    assert.equal(calls, 0);
    const inspected = await Promise.all([session, other].map(cookie => post('/api/panel/inspect', { url, division: 'Masters' }, cookie)));
    assert.ok(inspected.every(response => response.ok));
    assert.equal(calls, 1);
    const configured = await post('/api/panel/setup', settings, session);
    assert.equal(configured.status, 200, await configured.clone().text());
    const main = await configured.json();
    assert.equal(main.origin, origin);
    const separate = await (await get('/api/panel', other)).json();
    assert.equal(separate.config, null);
    assert.equal(separate.appearance.sound, true);
    assert.equal(separate.overlay.sounds.volume, defaultSounds.volume);
    assert.notEqual(main.url, separate.url);
    const monitor = await get('/api/panel/live-view', session);
    assert.equal(monitor.status, 200);
    assert.match(monitor.headers.get('content-security-policy')!, /frame-ancestors 'self'/);
    const monitorSource = await (await get('/api/panel/live-view/source', session)).json();
    assert.equal(monitorSource.path, new URL(main.url).pathname);
    const otherMonitor = await (await get('/api/panel/live-view/source', other)).json();
    assert.equal(otherMonitor.path, new URL(separate.url).pathname);
    const live = await open(main.url);
    assert.match((await live.read()).value!, /"notices":\[\]/);
    const preview = await open(main.previewUrl);
    await preview.read();
    assert.equal((await post('/api/panel/demo', { scenario: 'double' }, session)).status, 204);
    assert.match((await preview.read()).value!, /"outcome":"win".*"outcome":"loss"/);
    assert.equal((await post('/api/panel/demo/controls', { test: 'history-close' }, session)).status, 204);
    assert.match((await preview.read()).value!, /"control":\{"test":"history-close"\}/);
    assert.equal((await post('/api/panel/demo/controls', { stop: true }, session)).status, 204);
    assert.match((await preview.read()).value!, /"control":\{"stop":true\}/);
    assert.equal((await post('/api/panel/demo/controls', { test: 'incorrecto' }, session)).status, 400);
    await preview.cancel();
    const start = await post('/api/panel/tracking', { active: true }, session);
    assert.equal(start.status, 200);
    result = 3;
    let packet = '';
    while (!packet.includes('"kind":"result"')) packet = (await live.read()).value!;
    assert.match(packet, /"names":\["Álex"\]/);
    assert.doesNotMatch(packet, /"names":\["Sam"\]|Torneo simulado/);
    const refreshed = await open(main.url);
    assert.match((await refreshed.read()).value!, /"notices":\[\]/);
    await refreshed.cancel();
    const activeBeforeEdit = (await (await get('/api/panel', session)).json()).activeUntil;
    const appearance = { ...defaultAppearance, scoreboard: false, alerts: false, alertSize: 130,
      hideScoreboardDuringAlert: true,
      alertPosition: 'top-right', scoreboardPosition: 'bottom-center', entrance: 'left', table: false,
      scoreboardOffset: { x: -2.5, y: 1 }, alertOffset: { x: 5.3, y: -6 },
      marginX: 6.4, marginY: 8, scoreboardOpacity: 85, alertOpacity: 70,
      scoreboardMotion: { entrance: 'zoom', exit: 'left', effect: 'sweep', entranceMs: 320, exitMs: 250 },
      alertStyle: 'koi', alertLayout: 'banner', alertContent: 'data', alertTypes: ['loss'], alertEffect: 'sweep', alertExit: 'zoom',
      entranceMs: 450, exitMs: 350, alertGapMs: 0,
      scoreboardStyle: 'retro', scoreboardFields: { ...defaultAppearance.scoreboardFields, name: false, reverse: true } };
    assert.equal((await post('/api/panel/appearance', { appearance: { ...appearance, alertSize: 500 } }, session)).status, 400);
    assert.equal((await post('/api/panel/appearance', { appearance: { ...appearance, scoreboardStyle: 'invalid' } }, session)).status, 400);
    assert.equal((await post('/api/panel/appearance', { appearance: { ...appearance, alertLayout: 'invalid' } }, session)).status, 400);
    assert.equal((await post('/api/panel/appearance', { appearance: { ...appearance, alertContent: 'invalid' } }, session)).status, 400);
    assert.equal((await post('/api/panel/appearance', { appearance: { ...appearance, alertTypes: ['invalid'] } }, session)).status, 400);
    assert.equal((await post('/api/panel/appearance', { appearance: { ...appearance, entranceMs: 99 } }, session)).status, 400);
    assert.equal((await post('/api/panel/appearance', { appearance: { ...appearance, alertOffset: { x: 51, y: 0 } } }, session)).status, 400);
    assert.equal((await post('/api/panel/appearance', { appearance: { ...appearance, alertOpacity: 29 } }, session)).status, 400);
    assert.equal((await post('/api/panel/appearance', { appearance: { ...appearance, marginY: 16 } }, session)).status, 400);
    assert.equal((await post('/api/panel/appearance', { appearance: { ...appearance,
      scoreboardMotion: { ...appearance.scoreboardMotion, exitMs: null } } }, session)).status, 400);
    assert.equal((await post('/api/panel/appearance', { appearance: { ...appearance, hideScoreboardDuringAlert: 'true' } }, session)).status, 400);
    const edited = await (await post('/api/panel/appearance', {
      appearance, aliases: [{ id: 9, alias: 'Álex TV' }, { id: 31, alias: 'Sam' }],
    }, session)).json();
    assert.equal(edited.activeUntil, activeBeforeEdit);
    assert.equal(edited.config.players[0].alias, 'Álex TV');
    assert.equal(edited.url, main.url);
    assert.equal(edited.overlay.appearance.alertPosition, 'top-right');
    assert.deepEqual(edited.overlay.appearance.scoreboardOffset, appearance.scoreboardOffset);
    assert.deepEqual(edited.overlay.appearance.alertOffset, appearance.alertOffset);
    assert.equal(edited.overlay.appearance.marginX, 6.4);
    assert.equal(edited.overlay.appearance.alertOpacity, 70);
    assert.deepEqual(edited.overlay.appearance.scoreboardMotion, appearance.scoreboardMotion);
    assert.equal(edited.overlay.appearance.scoreboardStyle, 'retro');
    assert.equal(edited.overlay.appearance.scoreboardFields.name, false);
    assert.equal(edited.overlay.appearance.hideScoreboardDuringAlert, true);
    assert.deepEqual(edited.overlay.appearance.alertTypes, ['loss']);
    assert.equal(edited.overlay.appearance.alertContent, 'data');
    for (const key of ['alertStyle', 'alertLayout', 'alertEffect', 'alertExit', 'entranceMs', 'exitMs', 'alertGapMs'] as const) {
      assert.equal(edited.overlay.appearance[key], appearance[key]);
    }
    const shown = await (await post('/api/panel/scoreboard', { visible: true }, session)).json();
    assert.equal(shown.appearance.scoreboard, true);
    assert.equal(shown.appearance.alerts, false);
    assert.equal(shown.activeUntil, activeBeforeEdit);
    assert.equal(shown.url, main.url);
    const boardEvents = await open(main.url);
    await boardEvents.read();
    assert.equal((await post('/api/panel/score-menu', { selected: { id: 9, kind: 'team' } }, other)).status, 400);
    const teamMenu = await (await post('/api/panel/score-menu', { selected: { id: 9, kind: 'team' } }, session)).json();
    assert.deepEqual(teamMenu.overlay.programMenu.selected, { id: 9, kind: 'team' });
    assert.equal(teamMenu.activeUntil, activeBeforeEdit);
    await until(async () => /"selected":\{"id":9,"kind":"team"\}/.test((await boardEvents.read()).value ?? ''));
    const previewState = await (await get(main.previewUrl + '/state')).json();
    assert.equal(previewState.programMenu, undefined);
    const historyMenu = await (await post('/api/panel/score-menu', { selected: { id: 31, kind: 'history' } }, session)).json();
    assert.deepEqual(historyMenu.overlay.programMenu.selected, { id: 31, kind: 'history' });
    await until(async () => /"selected":\{"id":31,"kind":"history"\}/.test((await boardEvents.read()).value ?? ''));
    const hidden = await (await post('/api/panel/scoreboard', { visible: false }, session)).json();
    assert.equal(hidden.appearance.scoreboard, false);
    assert.equal(hidden.overlay.programMenu.selected, null);
    await boardEvents.cancel();
    assert.equal(hidden.appearance.scoreboardStyle, 'retro');
    assert.equal((await post('/api/panel/sprites', { id: 55, file: 'jugador.png' }, session)).status, 400);
    assert.equal((await post('/api/panel/sprites', { id: 9, image: 'data:image/png;base64,SG9sYQ==' }, session)).status, 400);
    assert.equal((await post('/api/panel/sprites', { id: 9, file: 'pokemon.png' }, session)).status, 400);
    const spriteSaved = await (await post('/api/panel/sprites', { id: 9, file: 'jugador.png' }, session)).json();
    assert.equal(spriteSaved.media.players['9'].avatar, 'jugador.png');
    const spriteVersion = spriteSaved.overlay.cards[0].sprite;
    assert.match(spriteVersion, /^[0-9a-f]{16}$/);
    assert.equal(spriteSaved.activeUntil, activeBeforeEdit);
    const spriteRoute = `/sprite/9/${spriteVersion}`;
    const sprite = await get(main.url + spriteRoute);
    assert.equal(sprite.headers.get('content-type'), 'image/png');
    assert.equal(Buffer.from(await sprite.arrayBuffer()).toString('base64'), pixel);
    assert.equal((await get(separate.url + spriteRoute)).status, 404);
    const appliedPokemon = await (await post('/api/panel/sprites', { kind: 'pokemon', id: 9, file: 'pokemon.png' }, session)).json();
    const pokemonVersion = appliedPokemon.overlay.cards[0].pokemon;
    assert.match(pokemonVersion, /^[0-9a-f]{16}$/);
    assert.equal(appliedPokemon.overlay.cards[0].sprite, spriteVersion);
    assert.deepEqual(appliedPokemon.overlay.cards[0].team, [pokemonVersion, null, null, null, null, null]);
    assert.equal((await post('/api/panel/sprites', { kind: 'pokemon', id: 9, slot: 7, file: 'pokemon.png' }, session)).status, 400);
    const six = await (await post('/api/panel/sprites', { kind: 'pokemon', id: 9, slot: 6, file: 'pokemon.png' }, session)).json();
    assert.equal(six.overlay.cards[0].team[5], pokemonVersion);
    assert.ok(six.overlay.cards[1].team.every((version: string | null) => version === null));
    const sixth = `/pokemon/9/6/${pokemonVersion}`;
    assert.equal((await get(main.url + sixth)).status, 200);
    assert.equal((await get(separate.url + sixth)).status, 404);
    const pokemonVideo = await (await post('/api/panel/sprites', {
      kind: 'pokemon', id: 9, slot: 2, file: 'Garchomp_HOME.webm',
    }, session)).json();
    assert.deepEqual(pokemonVideo.overlay.cards[0].teamVideoSlots, [2]);
    const videoRoute = `/pokemon/9/2/${pokemonVideo.overlay.cards[0].team[1]}`;
    const video = await fetch(new URL(main.previewUrl + videoRoute, origin), { headers: { range: 'bytes=0-3' } });
    assert.equal(video.status, 206);
    assert.equal(video.headers.get('content-type'), 'video/webm');
    assert.equal(Buffer.from(await video.arrayBuffer()).toString('hex'), '1a45dfa3');
    assert.equal((await get(separate.previewUrl + videoRoute)).status, 404);
    const embedded = '/api/panel/sprite-preview';
    assert.equal((await get(embedded)).status, 401);
    const embedPage = await get(embedded, session);
    assert.equal(embedPage.status, 200);
    assert.match(embedPage.headers.get('content-security-policy')!, /frame-ancestors 'self'/);
    assert.equal((await get(embedded + '/state?gif=draw_01.gif&type=win')).status, 401);
    assert.equal((await get(embedded + '/state?gif=falta.gif&type=win', session)).status, 404);
    const noticePreview = await (await get(embedded + '/state?gif=draw_01.gif&type=win', session)).json();
    assert.deepEqual(noticePreview.state.gifs, { win: ['draw_01.gif'] });
    assert.equal(noticePreview.state.sound, false);
    assert.equal(noticePreview.state.appearance.alertLayout, 'banner');
    assert.equal(noticePreview.notices[0].outcome, 'win');
    const draftRoute = embedded + '/state?' + new URLSearchParams({
      gif: 'draw_01.gif', type: 'loss', appearance: JSON.stringify({ ...appearance, alertLayout: 'card', duration: 3 }),
    });
    const revisedNotice = await (await get(draftRoute, session)).json();
    assert.equal(revisedNotice.state.appearance.alertLayout, 'card');
    assert.equal(revisedNotice.state.duration, 3);
    assert.equal(revisedNotice.notices[0].outcome, 'loss');
    assert.deepEqual(revisedNotice.state.appearance.alertOffset, appearance.alertOffset);
    assert.equal((await (await get('/api/panel', session)).json()).appearance.alertLayout, 'banner');
    assert.equal((await get(embedded + '/state?player=55&openTeam=1', session)).status, 404);
    const openTeam = await (await get(embedded + '/state?player=9&openTeam=1', session)).json();
    assert.equal(openTeam.players['9'].team[1], 'Garchomp_HOME.webm');
    assert.deepEqual(openTeam.state.programMenu.selected, { id: 9, kind: 'team' });
    assert.equal(openTeam.state.appearance.scoreboard, true);
    const onlyScore = await (await get(embedded + '/state?player=9&openTeam=0', session)).json();
    assert.equal(onlyScore.state.programMenu.selected, null);
    assert.equal(onlyScore.state.appearance.scoreboard, false);
    const history = await (await get(main.previewUrl + '/history/9')).json();
    assert.equal(history.matches[0].round, 1);
    assert.equal(history.matches[0].opponent.name, 'Rival');
    assert.equal(history.matches[0].outcome, 'win');
    assert.equal((await get(main.url + '/history/55')).status, 404);
    assert.equal((await get(separate.url + '/history/9')).status, 404);
    assert.equal((await get(main.previewUrl + '/gifs/tie/draw_01.gif')).status, 200);
    const noTieGif = await (await post('/api/panel/notice-gifs', { type: 'tie', files: [] }, session)).json();
    assert.deepEqual(noTieGif.overlay.gifs.tie, []);
    assert.equal((await get(main.previewUrl + '/gifs/tie/draw_01.gif')).status, 404);
    assert.equal((await post('/api/panel/notice-gifs', { type: 'win', files: ['imagen.png'] }, session)).status, 400);
    const gifs = await (await post('/api/panel/notice-gifs', { type: 'win', files: ['uno.gif', 'dos.gif', 'uno.gif'] }, session)).json();
    assert.deepEqual(gifs.overlay.gifs.win, ['uno.gif', 'dos.gif']);
    assert.equal(gifs.activeUntil, activeBeforeEdit);
    const playedGif = await get(main.previewUrl + '/gifs/win/uno.gif');
    assert.equal(playedGif.status, 200);
    assert.equal(playedGif.headers.get('content-type'), 'image/gif');
    assert.equal((await get(separate.previewUrl + '/gifs/win/uno.gif')).status, 404);
    assert.equal((await get(main.previewUrl + '/gifs/loss/uno.gif')).status, 404);
    const sounds = { ...defaultSounds, volume: 25, byType: { ...defaultSounds.byType, loss: 'mute', win: 'rise' }, files: { win: 'tono.wav' } };
    assert.equal((await post('/api/panel/sounds', { enabled: true, sounds: { ...sounds, volume: 200 } }, session)).status, 400);
    const appliedSounds = await (await post('/api/panel/sounds', { enabled: true, sounds }, session)).json();
    assert.equal(appliedSounds.activeUntil, activeBeforeEdit);
    assert.deepEqual(appliedSounds.overlay.sounds, sounds);
    assert.equal((await get(main.url + '/media/sounds/tono.wav')).headers.get('content-type'), 'audio/wav');
    assert.equal((await get(separate.url + '/media/sounds/tono.wav')).status, 404);
    assert.equal((await post('/api/panel/sounds/win', { choices: ['tone:bad'] }, session)).status, 400);
    assert.equal((await post('/api/panel/sounds/team', { choices: ['file:falta.wav'] }, session)).status, 400);
    const rotation = await (await post('/api/panel/sounds/win', { choices: ['tone:rise', 'file:tono.wav', 'tone:rise'] }, session)).json();
    assert.deepEqual(rotation.overlay.sounds.choices.win, ['tone:rise', 'file:tono.wav']);
    const teamAudio = await (await post('/api/panel/sounds/team', { choices: ['tone:soft'] }, session)).json();
    assert.deepEqual(teamAudio.overlay.sounds.choices, { win: ['tone:rise', 'file:tono.wav'], team: ['tone:soft'] });
    const mix = { alerts: true, menus: false, alertsVolume: 75, menusVolume: 40 };
    const volume = await (await post('/api/panel/sounds/volume', { volume: 40, enabled: true, mix }, session)).json();
    assert.deepEqual(volume.overlay.sounds, { ...teamAudio.overlay.sounds, volume: 40, mix });
    assert.equal((await post('/api/panel/sounds/volume', { volume: 40, enabled: true, mix: { ...mix, menusVolume: 101 } }, session)).status, 400);
    const soundScene = await (await get(embedded + '/state?soundPreview=win', session)).json();
    assert.equal(soundScene.state.sound, false);
    assert.equal(soundScene.notices[0].outcome, 'win');
    assert.deepEqual(soundScene.state.gifs.win, ['uno.gif', 'dos.gif']);
    const dashboardTrial = await (await get(embedded + '/state?soundPreview=double', session)).json();
    assert.equal(dashboardTrial.state.simulation, true);
    assert.deepEqual(dashboardTrial.notices.map((notice: { outcome: string }) => notice.outcome), ['win', 'loss']);
    const menuScene = await (await get(embedded + '/state?soundPreview=history', session)).json();
    assert.equal(menuScene.state.programMenu.selected.kind, 'history');
    const closeScene = await (await get(embedded + '/state?soundPreview=team-close', session)).json();
    assert.equal(closeScene.state.programMenu.selected.kind, 'team');
    const closingAudio = await (await post('/api/panel/sounds/team-close', { choices: ['tone:drop'] }, session)).json();
    assert.deepEqual(closingAudio.overlay.sounds.choices['team-close'], ['tone:drop']);
    const liveEdit = await open(main.url);
    assert.match((await liveEdit.read()).value!, /"scoreboard":false/);
    const styledPreview = await open(main.previewUrl);
    assert.match((await styledPreview.read()).value!, /"alertSize":130/);
    await post('/api/panel/demo', { scenario: 'win' }, session);
    assert.match((await styledPreview.read()).value!, /"names":\["Álex TV"\]/);
    await styledPreview.cancel();
    const reenabled = await post('/api/panel/appearance', { appearance: { ...appearance, alerts: true } }, session);
    assert.equal(reenabled.status, 200);
    result = 1;
    let muted = '';
    while (!muted.includes('"outcome":"tie"')) muted = (await liveEdit.read()).value!;
    assert.match(muted, /"alerts":true/);
    assert.match(muted, /"notices":\[\]/);
    await liveEdit.cancel();
    fail = true;
    await until(async () => (await (await get('/api/panel', session)).json()).status.phase === 'error');
    const stale = await (await get(main.url + '/state')).json();
    assert.equal(stale.cards[0].match.outcome, 'tie');
    const rotated = await (await post('/api/panel/links', { kind: 'live', action: 'rotate' }, session)).json();
    assert.notEqual(rotated.url, main.url);
    assert.equal((await get(main.url)).status, 404);
    assert.equal((await get(main.url + spriteRoute)).status, 404);
    let revoked = '';
    while (!revoked.includes('event: revoked')) revoked = (await live.read()).value!;
    await live.cancel();
    for (const invalid of ['https://u:p@vgc.example.test', 'https://vgc.example.test/subcarpeta', 'http://vgc.example.test']) {
      assert.equal((await post('/api/panel/overlay-origin', { origin: invalid }, session)).status, 400);
    }
    const publishedOrigin = 'https://vgc.example.test';
    const published = await (await post('/api/panel/overlay-origin', { origin: publishedOrigin + '/' }, session)).json();
    assert.equal(published.origin, publishedOrigin);
    assert.equal(published.url, publishedOrigin + new URL(rotated.url).pathname);
    assert.equal(published.previewUrl, publishedOrigin + new URL(rotated.previewUrl).pathname);
    assert.equal(published.activeUntil, rotated.activeUntil);
    assert.equal((await (await get('/api/panel', other)).json()).origin, origin);
    assert.equal((await post('/api/panel/overlay-origin', { origin: null }, session, publishedOrigin)).status, 403);
    http.removeListener('request', service.app);
    await service.close();
    service = createService(options);
    http.on('request', service.app);
    const persisted = await (await get('/api/panel', session)).json();
    assert.equal(persisted.url, published.url);
    assert.equal(persisted.previewUrl, published.previewUrl);
    assert.equal(persisted.overlay.cards[0].match.outcome, 'tie');
    assert.equal(persisted.appearance.alertSize, 130);
    assert.equal(persisted.appearance.scoreboardStyle, 'retro');
    assert.equal(persisted.appearance.alertLayout, 'banner');
    assert.equal(persisted.appearance.alertContent, 'data');
    assert.deepEqual(persisted.appearance.alertTypes, ['loss']);
    assert.deepEqual(persisted.appearance.alertOffset, appearance.alertOffset);
    assert.equal(persisted.appearance.scoreboardOpacity, 85);
    assert.equal(persisted.appearance.marginY, 8);
    assert.deepEqual(persisted.appearance.scoreboardMotion, appearance.scoreboardMotion);
    assert.equal(persisted.appearance.hideScoreboardDuringAlert, true);
    assert.equal(persisted.appearance.exitMs, 350);
    assert.equal(persisted.appearance.scoreboardFields.reverse, true);
    assert.equal(persisted.overlay.cards[0].sprite, spriteVersion);
    assert.equal(persisted.overlay.cards[0].pokemon, pokemonVersion);
    assert.equal(persisted.overlay.cards[0].team[5], pokemonVersion);
    assert.deepEqual(persisted.overlay.cards[0].teamVideoSlots, [2]);
    const reloadedHistory = await (await get(rotated.url + '/history/9')).json();
    assert.equal(reloadedHistory.matches[0].outcome, 'tie');
    assert.deepEqual(persisted.overlay.gifs.win, ['uno.gif', 'dos.gif']);
    assert.deepEqual(persisted.overlay.sounds, closingAudio.overlay.sounds);
    assert.equal((await post('/api/panel/sprites', { id: 9, file: null }, session)).status, 200);
    assert.equal((await get(rotated.url + spriteRoute)).status, 404);
    assert.ok(persisted.activeUntil > Date.now());
    const restored = await (await post('/api/panel/overlay-origin', { origin: null }, session)).json();
    assert.equal(restored.origin, origin);
    assert.equal(restored.url, rotated.url);
    assert.equal(restored.previewUrl, rotated.previewUrl);
  } finally {
    await service.close();
    http.close();
    http.closeAllConnections();
    await rm(folder, { recursive: true, force: true });
  }
});
