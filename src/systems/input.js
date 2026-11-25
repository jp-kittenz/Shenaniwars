import { clamp } from '../core/math.js';

const STICK_RADIUS = 58;       // px of thumb travel for full deflection
const TOUCH_LOOK = 0.0052;     // rad per px
const MOUSE_LOOK = 0.0023;

/**
 * @typedef {'reload'|'swap'|'interact'|'seat'|'pause'|'jump'|'view'} EdgeAction
 */

/**
 * Unified input: touch-first dual-stick controls with contextual action
 * buttons, plus keyboard/mouse (pointer-lock) for desktop. Game code reads
 * the same normalised state regardless of the device.
 *
 * Touch mapping (landscape):
 *  - left 42% of the screen: floating movement stick (appears under the thumb)
 *  - rest of the screen: drag to look / aim; in helicopters the same thumb acts
 *    as a second stick (yaw + collective)
 *  - FIRE button doubles as a look pad so you can track targets while shooting
 */
export class InputSystem {
  /** @param {HTMLElement} layer  full-screen element that receives touches */
  constructor(layer) {
    this.layer = layer;
    this.isTouch = (navigator.maxTouchPoints || 0) > 0 || 'ontouchstart' in window;
    /** Movement stick, x = right, y = forward, each -1..1. */
    this.moveX = 0; this.moveY = 0;
    /** Accumulated look deltas (radians) since last consume. */
    this.lookX = 0; this.lookY = 0;
    /** Right thumb as a stick (used by aircraft), -1..1. */
    this.stickX = 0; this.stickY = 0;
    this.fire = false;
    this.ads = false;
    this.sprint = false;
    this.jumpHeld = false;
    this.sensitivity = 1;
    this.enabled = false;
    /** @type {Record<string, boolean>} */
    this._edges = {};
    /** @type {Record<string, boolean>} */
    this._keys = {};
    this._mouseFire = false; this._mouseAds = false; this._touchFire = false; this._touchAds = false;
    this._move = { id: -1, ox: 0, oy: 0 };
    this._look = { id: -1, ox: 0, oy: 0, lx: 0, ly: 0 };
    /** @type {Map<number, {lx:number, ly:number}>} look-drag state for touches that began on buttons */
    this._buttonDrags = new Map();
    /** @type {Record<string, HTMLElement>} */
    this.buttons = {};
    this._buildTouchUI();
    this._bindKeyboardMouse();
  }

  /** Returns true once per press of an edge-triggered action. @param {EdgeAction} name */
  take(name) {
    if (!this._edges[name]) return false;
    this._edges[name] = false;
    return true;
  }

  /** Reads and clears accumulated look deltas. @param {{x:number,y:number}} out */
  consumeLook(out) {
    out.x = this.lookX * this.sensitivity; out.y = this.lookY * this.sensitivity;
    this.lookX = 0; this.lookY = 0;
    return out;
  }

  reset() {
    this.moveX = this.moveY = this.lookX = this.lookY = this.stickX = this.stickY = 0;
    this.fire = this.ads = this.sprint = this.jumpHeld = false;
    this._mouseFire = this._mouseAds = this._touchFire = this._touchAds = false;
    this._keys = {}; this._edges = {};
    this._move.id = -1; this._look.id = -1;
    this._buttonDrags.clear();
    if (this.stickEl) this.stickEl.style.display = 'none';
  }

  /**
   * Shows the action buttons relevant to the player's situation.
   * @param {{inVehicle:boolean, canEnter:boolean, canSwitchSeat:boolean, hasWeapon:boolean, onFoot:boolean, canAim:boolean, canSwap:boolean}} c
   */
  setContext(c) {
    const b = this.buttons;
    if (!b.fire) return;
    const show = (el, on) => { const v = on ? '' : 'none'; if (el.style.display !== v) el.style.display = v; };
    show(b.interact, c.canEnter || c.inVehicle);
    const label = c.inVehicle ? 'EXIT' : 'ENTER';
    if (b.interact.textContent !== label) b.interact.textContent = label;
    show(b.seat, c.inVehicle && c.canSwitchSeat);
    if (b.view) show(b.view, c.inVehicle);
    show(b.fire, c.hasWeapon);
    show(b.ads, c.canAim);
    show(b.jump, c.onFoot);
    show(b.reload, c.onFoot);
    show(b.swap, c.canSwap);
  }

  // --- Touch -------------------------------------------------------------------

  _buildTouchUI() {
    const layer = this.layer;
    this.stickEl = document.createElement('div');
    this.stickEl.className = 'stick';
    this.knobEl = document.createElement('div');
    this.knobEl.className = 'knob';
    this.stickEl.appendChild(this.knobEl);
    layer.appendChild(this.stickEl);

    const defs = [
      ['fire', 'FIRE', 'hold'], ['ads', 'AIM', 'toggle'], ['jump', 'JUMP', 'edge'], ['reload', 'RELOAD', 'edge'],
      ['swap', 'SWAP', 'edge'], ['interact', 'ENTER', 'edge'], ['seat', 'SEAT', 'edge'], ['pause', 'II', 'edge'], ['view', 'VIEW', 'edge'],
    ];
    for (const [name, label, mode] of defs) {
      const el = document.createElement('button');
      el.className = `tbtn tbtn-${name}`;
      el.textContent = label;
      el.type = 'button';
      layer.appendChild(el);
      this.buttons[name] = el;
      el.addEventListener('pointerdown', (e) => {
        e.preventDefault(); e.stopPropagation();
        try { el.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
        el.classList.add('on');
        if (mode === 'hold') this._touchFire = true;
        else if (mode === 'toggle') { this._touchAds = !this._touchAds; el.classList.toggle('latched', this._touchAds); }
        else this._edges[name] = true;
        if (name === 'jump') this.jumpHeld = true;
        // Any button can be dragged to keep aiming while it is held.
        this._buttonDrags.set(e.pointerId, { lx: e.clientX, ly: e.clientY });
      });
      el.addEventListener('pointermove', (e) => {
        const d = this._buttonDrags.get(e.pointerId);
        if (!d) return;
        this.lookX += (e.clientX - d.lx) * TOUCH_LOOK; this.lookY += (e.clientY - d.ly) * TOUCH_LOOK;
        d.lx = e.clientX; d.ly = e.clientY;
      });
      const up = (e) => {
        el.classList.remove('on');
        if (mode === 'hold') this._touchFire = false;
        if (name === 'jump') this.jumpHeld = false;
        this._buttonDrags.delete(e.pointerId);
      };
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
    }
    if (!this.isTouch) for (const k in this.buttons) if (k !== 'pause') this.buttons[k].style.visibility = 'hidden';

    layer.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' || !this.enabled) return;
      e.preventDefault();
      const w = layer.clientWidth;
      if (e.clientX < w * 0.42 && this._move.id < 0) {
        this._move.id = e.pointerId; this._move.ox = e.clientX; this._move.oy = e.clientY;
        this.stickEl.style.display = 'block';
        this.stickEl.style.transform = `translate(${e.clientX}px, ${e.clientY}px)`;
        this.knobEl.style.transform = 'translate(0px, 0px)';
      } else if (this._look.id < 0) {
        const l = this._look;
        l.id = e.pointerId; l.ox = l.lx = e.clientX; l.oy = l.ly = e.clientY;
      }
    });
    layer.addEventListener('pointermove', (e) => {
      if (e.pointerId === this._move.id) {
        let dx = e.clientX - this._move.ox, dy = e.clientY - this._move.oy;
        const len = Math.hypot(dx, dy);
        if (len > STICK_RADIUS) { dx *= STICK_RADIUS / len; dy *= STICK_RADIUS / len; }
        this.knobEl.style.transform = `translate(${dx}px, ${dy}px)`;
        const nx = dx / STICK_RADIUS, ny = -dy / STICK_RADIUS;
        // Small dead zone so a resting thumb does not creep.
        const m = Math.hypot(nx, ny);
        const k = m < 0.12 ? 0 : (m - 0.12) / (0.88 * m);
        this.moveX = nx * k; this.moveY = ny * k;
        this.sprint = m > 0.94 && ny > 0.5;
      } else if (e.pointerId === this._look.id) {
        const l = this._look;
        this.lookX += (e.clientX - l.lx) * TOUCH_LOOK; this.lookY += (e.clientY - l.ly) * TOUCH_LOOK;
        l.lx = e.clientX; l.ly = e.clientY;
        this.stickX = clamp((e.clientX - l.ox) / STICK_RADIUS, -1, 1);
        this.stickY = clamp(-(e.clientY - l.oy) / STICK_RADIUS, -1, 1);
      }
    });
    const end = (e) => {
      if (e.pointerId === this._move.id) {
        this._move.id = -1; this.moveX = this.moveY = 0; this.sprint = false;
        this.stickEl.style.display = 'none';
      } else if (e.pointerId === this._look.id) {
        this._look.id = -1; this.stickX = this.stickY = 0;
      }
    };
    layer.addEventListener('pointerup', end);
    layer.addEventListener('pointercancel', end);
    layer.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  // --- Keyboard / mouse ---------------------------------------------------------

  _bindKeyboardMouse() {
    const edgeKeys = { KeyR: 'reload', KeyQ: 'swap', Digit1: 'swap', Digit2: 'swap', KeyE: 'interact', KeyF: 'seat', KeyV: 'view', KeyG: 'doors', KeyH: 'hatch', KeyL: 'light', Escape: 'pause', KeyP: 'pause', Space: 'jump' };
    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      this._keys[e.code] = true;
      if (edgeKeys[e.code]) this._edges[edgeKeys[e.code]] = true;
      if (this.enabled && (e.code === 'Space' || e.code.startsWith('Arrow'))) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => { this._keys[e.code] = false; });
    window.addEventListener('blur', () => { this._keys = {}; this._mouseFire = this._mouseAds = false; });
    const canvasLayer = this.layer;
    canvasLayer.addEventListener('mousedown', (e) => {
      if (!this.enabled || this.isTouch) return;
      if (document.pointerLockElement !== canvasLayer) { canvasLayer.requestPointerLock?.(); return; }
      if (e.button === 0) this._mouseFire = true;
      if (e.button === 2) this._mouseAds = true;
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) this._mouseFire = false;
      if (e.button === 2) this._mouseAds = false;
    });
    window.addEventListener('mousemove', (e) => {
      if (document.pointerLockElement !== canvasLayer) return;
      this.lookX += e.movementX * MOUSE_LOOK; this.lookY += e.movementY * MOUSE_LOOK;
    });
  }

  /** Folds device state into the public fields; call once per frame. */
  update() {
    const k = this._keys;
    if (this._move.id < 0) {
      const x = (k.KeyD ? 1 : 0) - (k.KeyA ? 1 : 0), y = (k.KeyW ? 1 : 0) - (k.KeyS ? 1 : 0);
      const len = Math.hypot(x, y) || 1;
      this.moveX = x / len; this.moveY = y / len;
      this.sprint = !!k.ShiftLeft && y > 0;
    }
    if (this._look.id < 0) {
      this.stickX = (k.ArrowRight ? 1 : 0) - (k.ArrowLeft ? 1 : 0);
      this.stickY = (k.Space ? 1 : 0) - (k.KeyC || k.ControlLeft ? 1 : 0);
    }
    this.fire = this._touchFire || this._mouseFire;
    this.ads = this._touchAds || this._mouseAds;
  }
}
