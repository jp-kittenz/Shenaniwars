import './ui/styles.css';
import { CONFIG, QUALITY, detectQuality } from './core/config.js';
import { Game } from './systems/game.js';

/**
 * Bootstrap: picks a quality tier, builds the game behind a loading bar,
 * wires the menus, and handles the mobile shell concerns (landscape lock,
 * fullscreen, resize, backgrounding, context loss, fatal errors).
 */

const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));
const QUALITY_KEY = 'shenaniwars.quality';

function showFatal(err) {
  console.error(err);
  $('fatal-text').textContent = String((err && err.stack) || err);
  $('fatal').classList.remove('hidden');
}
window.addEventListener('error', (e) => showFatal(e.error || e.message));
window.addEventListener('unhandledrejection', (e) => showFatal(e.reason));

/** @returns {'low'|'medium'|'high'} */
function pickQuality() {
  const fromUrl = new URLSearchParams(location.search).get('q');
  let stored = null;
  try { stored = localStorage.getItem(QUALITY_KEY); } catch { /* storage unavailable */ }
  const q = fromUrl || stored;
  return q && q in QUALITY ? /** @type {any} */ (q) : detectQuality();
}

/** Best-effort fullscreen + landscape lock; both need a user gesture and may be refused. */
async function enterImmersive() {
  const root = /** @type {any} */ (document.documentElement);
  try {
    if (!document.fullscreenElement) await (root.requestFullscreen || root.webkitRequestFullscreen)?.call(root, { navigationUI: 'hide' });
  } catch { /* not allowed (e.g. iOS Safari) */ }
  try { await /** @type {any} */ (screen.orientation)?.lock?.('landscape'); } catch { /* unsupported */ }
}

async function boot() {
  const isTouch = (navigator.maxTouchPoints || 0) > 0 || 'ontouchstart' in window;
  document.body.classList.toggle('touch', isTouch);
  const canvas = /** @type {HTMLCanvasElement} */ ($('game'));
  const quality = pickQuality();

  const probe = document.createElement('canvas').getContext('webgl2');
  if (!probe) throw new Error('WebGL 2 is required but not available on this device/browser.');

  const game = await Game.create(canvas, $('touch'), quality, (fraction, label) => {
    $('loading-bar').style.transform = `scaleX(${fraction})`;
    $('loading-text').textContent = label;
  });
  /** @type {any} */ (window).__game = game; // debugging / automated tests

  // --- Menus --------------------------------------------------------------------
  const menu = $('menu'), hud = $('hud'), over = $('gameover');
  $('loading').classList.add('hidden');
  $('menu-main').classList.remove('hidden');
  for (const b of document.querySelectorAll('.quality button')) {
    const el = /** @type {HTMLButtonElement} */ (b);
    el.classList.toggle('sel', el.dataset.q === quality);
    el.addEventListener('click', () => {
      if (el.dataset.q === quality) return;
      try { localStorage.setItem(QUALITY_KEY, /** @type {string} */ (el.dataset.q)); } catch { /* ignore */ }
      const url = new URL(location.href);
      url.searchParams.delete('q');
      location.replace(url);
    });
  }
  // Side picker: available before deploying (the human swaps places with a bot).
  const sideButtons = /** @type {HTMLButtonElement[]} */ ([...document.querySelectorAll('#side-row button')]);
  const markSide = () => sideButtons.forEach((b) => b.classList.toggle('sel', +(/** @type {string} */ (b.dataset.team)) === game.player.team));
  sideButtons.forEach((b) => b.addEventListener('click', () => { game.setPlayerTeam(+(/** @type {string} */ (b.dataset.team))); markSide(); }));
  markSide();
  const setMenu = (open, paused) => {
    menu.classList.toggle('hidden', !open);
    hud.classList.toggle('hidden', open);
    $('touch').style.pointerEvents = open ? 'none' : 'auto';
    $('btn-deploy').classList.toggle('hidden', paused);
    $('btn-resume').classList.toggle('hidden', !paused);
    $('btn-save').classList.toggle('hidden', !paused);
    $('side-row').classList.toggle('hidden', paused);
    $('btn-load').classList.toggle('hidden', !game.state.hasSave());
  };
  setMenu(true, false);

  $('btn-deploy').addEventListener('click', () => { if (isTouch) enterImmersive(); game.deploy(); });
  $('btn-resume').addEventListener('click', () => { if (isTouch) enterImmersive(); game.resume(); });
  $('btn-save').addEventListener('click', () => {
    $('btn-save').textContent = game.state.save() ? 'SAVED ✓' : 'SAVE FAILED';
    setTimeout(() => { $('btn-save').textContent = 'SAVE'; }, 1200);
    $('btn-load').classList.remove('hidden');
  });
  $('btn-load').addEventListener('click', () => {
    if (!game.loadSave()) { $('btn-load').textContent = 'NO SAVE'; return; }
    if (game.mode === 'menu') game.deploy(); else game.resume();
  });
  $('btn-mute').addEventListener('click', () => {
    game.audio.unlock();
    game.audio.setMuted(!game.audio.muted);
    $('btn-mute').textContent = game.audio.muted ? 'SOUND OFF' : 'SOUND ON';
  });
  $('btn-restart').addEventListener('click', () => { over.classList.add('hidden'); game.restart(); });

  game.bus.on('mode', (mode, winner) => {
    if (mode === 'playing') setMenu(false, false);
    else if (mode === 'paused') setMenu(true, true);
    else if (mode === 'over') {
      const won = winner === game.player.team;
      $('gameover-title').textContent = won ? 'VICTORY' : 'DEFEAT';
      $('gameover-title').style.color = CONFIG.teams[winner].css;
      $('gameover-stats').textContent = `${CONFIG.teams[winner].name} holds the island · you: ${game.player.kills} kills / ${game.player.deaths} deaths`;
      over.classList.remove('hidden');
      $('touch').style.pointerEvents = 'none';
    }
  });
  game.bus.on('fatal', showFatal);

  // --- Shell events -------------------------------------------------------------
  let resizeQueued = false;
  const onResize = () => {
    if (resizeQueued) return;
    resizeQueued = true;
    requestAnimationFrame(() => { resizeQueued = false; game.render.resize(); });
  };
  window.addEventListener('resize', onResize);
  window.addEventListener('orientationchange', onResize);
  /** @type {any} */ (window).visualViewport?.addEventListener('resize', onResize);
  document.addEventListener('visibilitychange', () => { if (document.hidden) game.pause(); });
  const portrait = window.matchMedia('(orientation: portrait) and (pointer: coarse)');
  portrait.addEventListener?.('change', (e) => { if (e.matches) game.pause(); });
  document.addEventListener('pointerlockchange', () => {
    // Leaving pointer lock with Esc is the desktop pause gesture.
    if (!isTouch && !document.pointerLockElement && game.mode === 'playing') game.pause();
  });
  canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); game.pause(); game.stop(); });
  canvas.addEventListener('webglcontextrestored', () => location.reload());
  // Block the iOS double-tap zoom and pinch gestures that would steal thumbs.
  document.addEventListener('gesturestart', (e) => e.preventDefault());
  document.addEventListener('dblclick', (e) => e.preventDefault());

  game.start();
}

boot().catch(showFatal);
