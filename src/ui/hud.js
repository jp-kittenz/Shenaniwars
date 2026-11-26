import { CAP_PHASE_NAMES } from '../systems/capture-rate.js';
import { CONFIG } from '../core/config.js';
import { clamp } from '../core/math.js';
import { SIEGE_DELAY } from '../systems/capture.js';

const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));
/** Minimap colours for ground cover (Terrain.surf). */
const SURF_MAP = { 1: [150, 148, 140], 2: [86, 86, 90], 3: [196, 170, 86], 4: [96, 146, 64], 5: [124, 92, 64], 6: [170, 160, 140], 7: [70, 110, 140], 9: [116, 96, 70] };
const MAP_SPAN = 320; // metres shown across the minimap

/**
 * DOM heads-up display. Every write is guarded by a cached previous value so
 * the HUD never forces layout unless something actually changed, and the
 * minimap redraws at 8 Hz rather than per frame.
 */
export class Hud {
  /** @param {import('../systems/game.js').Game} game */
  constructor(game) {
    this.game = game;
    this.root = $('hud');
    this.el = {
      tk: [$('tk0'), $('tk1')], tb: [$('tb0'), $('tb1')], flags: $('flags'),
      capture: $('capture'), captureLabel: $('capture-label'), captureBar: $('capture-bar'),
      feed: $('feed'), hit: $('hitmarker'), prompt: $('prompt'), notice: $('notice'),
      vehicle: $('vehicle'), vehicleName: $('vehicle-name'), vehicleBar: $('vehicle-bar'),
      health: $('health'), healthBar: $('health-bar'), healthNum: $('health-num'),
      weapon: $('weapon-name'), ammo: $('ammo-num'), respawn: $('respawn'), respawnNum: $('respawn-num'),
      crosshair: $('crosshair'), debug: $('debug'), flight: $('flight'), warn: $('warn'),
      phase: $('phase'), hq: [$('hq0'), $('hq1')],
    };
    /** HQ pips per side. */
    this._hqPips = this.el.hq.map((el) => [0, 1, 2, 3].map(() => el.appendChild(document.createElement('u'))));
    /** @type {Record<string, any>} last written values */
    this._c = {};
    // The strip shows the twelve objectives; the bases are not capturable.
    this._flagEls = game.capture.flags.map((f) => {
      if (f.base) return null;
      const b = document.createElement('b');
      b.textContent = f.name[0];
      this.el.flags.appendChild(b);
      return b;
    });
    this.minimap = /** @type {HTMLCanvasElement} */ ($('minimap'));
    this._ctx = /** @type {CanvasRenderingContext2D} */ (this.minimap.getContext('2d'));
    // Operations panel: tap the minimap to see what your side's commander is actually running.
    this._zones = [];
    this._opsPanel = document.createElement('div');
    this._opsPanel.className = 'ops-panel hidden';
    this.minimap.parentElement.appendChild(this._opsPanel);
    // The touch-control layer sits above the HUD: catch taps inside the minimap's rectangle first.
    window.addEventListener('pointerdown', (e) => {
      if (this.game.mode !== 'playing') return;
      const r = this.minimap.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) return;
      e.stopPropagation(); e.preventDefault();
      this._opsPanel.classList.toggle('hidden'); this._opsT = 0;
    }, true);
    this._mapImage = this._renderMapImage();
    this._mapTimer = 0;
    this._slow = 0;
    this._noticeTimer = 0;
    this.damageFlash = 0;
    this.debug = new URLSearchParams(location.search).has('debug');
    this.el.debug.classList.toggle('hidden', !this.debug);
    this._fps = 60;

    const bus = game.bus;
    bus.on('kill', (attacker, victim, cause) => this._feed(attacker, victim, cause));
    bus.on('hit', (killed) => {
      const h = this.el.hit;
      h.className = '';
      void h.offsetWidth; // restart the CSS animation
      h.className = killed ? 'kill' : 'hit';
      bus.emit('sound', killed ? 'kill' : 'hit');
    });
    bus.on('flag:changed', (flag, owner) => {
      game.chunks.setFlagOwner(flag.id, owner);
      if (owner >= 0) {
        this.notice(`${CONFIG.teams[owner].name} CAPTURED ${flag.name}`, CONFIG.teams[owner].css);
        if (owner === game.player.team) bus.emit('sound', 'capture');
      } else this.notice(`${flag.name} NEUTRALISED`, '#fff');
    });
    bus.on('notice', (text) => this.notice(text, '#fff'));
    bus.on('player:damaged', (amount) => { this.damageFlash = Math.min(1, this.damageFlash + amount / 45); });
  }

  /** Bakes a top-down colour image of the island for the minimap background. */
  _renderMapImage() {
    const size = 384, t = this.game.map.terrain;
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const ctx = /** @type {CanvasRenderingContext2D} */ (c.getContext('2d'));
    const img = ctx.createImageData(size, size);
    for (let j = 0; j < size; j++) {
      for (let i = 0; i < size; i++) {
        const x = -t.half + ((i + 0.5) / size) * t.size, z = -t.half + ((j + 0.5) / size) * t.size;
        const h = t.height(x, z), o = (j * size + i) * 4;
        let r, g, b;
        if (h < CONFIG.world.waterLevel) { r = 28; g = 62; b = 84; }
        else {
          const k = clamp(h / 55, 0, 1), shade = clamp(1 + (t.height(x - 6, z - 6) - h) * 0.05, 0.7, 1.3);
          r = (62 + 70 * k) * shade; g = (88 + 40 * k) * shade; b = (54 + 30 * k) * shade;
          const road = t.roadAt(x, z);
          r += (150 - r) * road; g += (132 - g) * road; b += (100 - b) * road;
          const sf = t.surfAt(x, z), sc = SURF_MAP[sf];
          if (sc) { r = sc[0]; g = sc[1]; b = sc[2]; }
          if (t.pavedAt(x, z) > 0) { r = 92; g = 92; b = 96; }
        }
        img.data[o] = r; img.data[o + 1] = g; img.data[o + 2] = b; img.data[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    // Building footprints.
    const k = size / t.size;
    for (const bl of this.game.map.buildings || []) {
      if (bl.name === 'tunnel') continue;
      ctx.save();
      ctx.translate((bl.x + t.half) * k, (bl.z + t.half) * k);
      ctx.rotate(-bl.rot);
      ctx.fillStyle = bl.team === 0 ? '#5e8f88' : bl.team === 1 ? '#9a6a4a' : bl.state === 2 ? '#5a524a' : '#b8b2a6';
      ctx.fillRect((-bl.w / 2) * k, (-bl.d / 2) * k, Math.max(1, bl.w * k), Math.max(1, bl.d * k));
      ctx.restore();
    }
    return c;
  }

  /** Air net: the last radio calls of the player's side while the player flies (or with ?debug). */
  _airNet() {
    const g = this.game, atc = g.atc, p = g.player;
    if (!atc) return;
    const show = this.debug || (p && p.vehicle && p.vehicle.isAircraft);
    if (!this._airEl) {
      const d = document.createElement('div');
      d.id = 'airnet';
      d.style.cssText = 'position:absolute;left:12px;bottom:120px;max-width:46vw;font:12px/1.35 system-ui,sans-serif;color:#cfe8ff;text-shadow:0 1px 2px #000;pointer-events:none;white-space:pre-wrap;opacity:.92';
      document.body.appendChild(d);
      this._airEl = d;
    }
    if (!show) { this._airEl.textContent = ''; return; }
    const lines = atc.recent(p ? p.team : 0, 5).filter((m) => g.time - m.t < 40).map((m) => `${m.from}: ${m.text}`);
    this._airEl.textContent = lines.length ? 'AIR NET\n' + lines.join('\n') : '';
  }

  notice(text, color) {
    const n = this.el.notice;
    n.textContent = text;
    n.style.color = color;
    n.classList.add('show');
    this._noticeTimer = 2.6;
  }

  _feed(attacker, victim, cause) {
    const feed = this.el.feed, me = this.game.player;
    if (!attacker && victim !== me) return;
    const row = document.createElement('div');
    const name = (s) => { const b = document.createElement('span'); b.className = `n${s.team}`; b.textContent = s.name; return b; };
    if (attacker && attacker !== victim) { row.appendChild(name(attacker)); row.appendChild(document.createTextNode(` ▸ ${cause || ''} ▸ `)); }
    row.appendChild(name(victim));
    if (!attacker || attacker === victim) row.appendChild(document.createTextNode(' ✕'));
    if (attacker === me || victim === me) row.className = 'me';
    feed.appendChild(row);
    while (feed.childElementCount > 5) /** @type {Element} */ (feed.firstElementChild).remove();
    setTimeout(() => row.remove(), 6000);
  }

  _set(key, el, prop, value) {
    if (this._c[key] === value) return;
    this._c[key] = value;
    if (prop === 'text') el.textContent = value;
    else if (prop === 'scale') el.style.transform = `scaleX(${value})`;
    else if (prop === 'hidden') el.classList.toggle('hidden', value);
    else if (prop === 'transform') { const [x, y] = value.split(','); el.style.transform = `translate(${x}px, ${y}px)`; }
    else el.className = value;
  }

  /** @param {number} dt */
  update(dt) {
    const g = this.game, s = g.player, e = this.el, cap = g.capture;
    this.damageFlash = Math.max(0, this.damageFlash - dt * 1.4);
    g.render.damage = this.damageFlash + (s.alive ? clamp(1 - s.health / 45, 0, 0.6) : 0.5);
    if (this._noticeTimer > 0 && (this._noticeTimer -= dt) <= 0) e.notice.classList.remove('show');
    this._fps += (1 / Math.max(dt, 0.001) - this._fps) * 0.05;

    // Per-frame essentials (cheap, value-cached).
    const v = s.vehicle;
    const hp = Math.max(0, Math.ceil(s.health));
    this._set('hp', e.healthNum, 'text', hp);
    this._set('hpb', e.healthBar, 'scale', (hp / CONFIG.soldier.health).toFixed(2));
    this._set('hpl', e.health, 'class', hp < 35 ? 'low' : '');
    const ctl = g.playerCtl;
    let w = s.weapon;
    if (v) w = ctl.mount >= 0 ? v.weapons[ctl.mount] : /** @type {any} */ (null);
    const nWeapons = v ? v.mountList(s.seat).length : s.weapons.length;
    this._set('wn', e.weapon, 'text', w ? `${w.def.name}${nWeapons > 1 ? '  ⇄' : ''}` : v ? v.def.seats[s.seat].role.toUpperCase() : '');
    let ammo = !w ? '—' : w.reloading ? 'RELOADING' : w.def.mag === Infinity ? (w.cooldown > 0.4 ? 'LOADING' : 'READY') : `${w.ammo} / ${w.reserve === Infinity ? '∞' : w.reserve}`;
    if (w && w.def.homing === 'air' && !w.reloading) ammo = ctl.lock ? (ctl.lockTime > 0.8 ? 'LOCKED' : 'LOCKING…') : 'NO LOCK';
    this._set('am', e.ammo, 'text', ammo);
    // Flight / artillery readout.
    let flight = '';
    if (v && v.isAircraft && s.seat === 0) {
      flight = `SPD ${Math.round(v.airspeed * 3.6)}  ALT ${Math.round(v.altitude)}`;
      if (v.def.kind === 'jet') flight += `  THR ${Math.round(v.controls.throttle * 100)}%`;
    } else if (ctl.artyRange > 0) flight = `RANGE ${ctl.artyRange} m`;
    this._set('fl', e.flight, 'text', flight);
    this._set('flh', e.flight, 'hidden', flight === '');
    const out = v && v.isAircraft && Math.max(Math.abs(v.pos.x), Math.abs(v.pos.z)) > g.map.terrain.half + 140;
    this._set('warn', e.warn, 'hidden', !out);
    // Fixed aircraft weapons: the crosshair shows where the nose points.
    const bs = ctl.boresight;
    const ox = bs ? Math.round(bs.x * this.root.clientWidth * 0.5) : 0, oy = bs ? Math.round(-bs.y * this.root.clientHeight * 0.5) : 0;
    this._set('bs', e.crosshair, 'transform', `${ox},${oy}`);
    this._set('vh', e.vehicle, 'hidden', !v);
    if (v) {
      const role = v.def.kind !== 'ground' && s.seat === 0 ? 'PILOT' : v.def.seats[s.seat].role.toUpperCase();
      this._set('vn', e.vehicleName, 'text', `${v.def.label} · ${role}`);
      this._set('vb', e.vehicleBar, 'scale', clamp(v.health / v.def.health, 0, 1).toFixed(2));
    }
    this._set('ch', e.crosshair, 'hidden', !s.alive || (ctl.adsT > 0.6 && !v) || (!!v && ctl.mount < 0));
    const near = g.playerCtl.nearVehicle;
    this._set('pr', e.prompt, 'hidden', !near || !s.alive);
    if (near) this._set('prt', e.prompt, 'text', `${g.input.isTouch ? 'ENTER' : '[E] ENTER'} ${near.def.label}${!g.input.isTouch && near.doorOpen.length ? ' · [G] DOORS' : ''}`);
    this._set('rs', e.respawn, 'hidden', s.alive || cap.over || g.mode !== 'playing');
    if (!s.alive) this._set('rsn', e.respawnNum, 'text', Math.max(0, Math.ceil(s.respawnTimer)));

    // Slow lane (4 Hz): tickets, flags, capture bar.
    if ((this._slow -= dt) <= 0) {
      this._slow = 0.25;
      for (let t = 0; t < 2; t++) {
        this._set(`tk${t}`, e.tk[t], 'text', cap.tickets[t]);
        this._set(`tb${t}`, e.tb[t], 'scale', (cap.tickets[t] / CONFIG.match.tickets).toFixed(2));
      }
      let here = null;
      this._airNet();
      this._endgame(g, cap, s);
      cap.flags.forEach((f, i) => {
        if (!this._flagEls[i]) return;
        this._set(`f${i}`, this._flagEls[i], 'class', `${f.owner >= 0 ? `o${f.owner}` : ''} ${f.contestedBy >= 0 ? `c${f.contestedBy}` : ''}`);
        if (s.alive && (f.x - s.pos.x) ** 2 + (f.z - s.pos.z) ** 2 < CONFIG.match.captureRadius ** 2) here = f;
      });
      this._set('cp', e.capture, 'hidden', !here);
      if (here) {
        // Bar grows from the centre toward the side of the team in control.
        const mine = s.team === 0 ? -here.v : here.v;
        // Phase of the situational capture and its rate (NEUTRALIZING 1.2× / SECURING / CONTESTED / OVERRUN 0.35×).
        const ph = CAP_PHASE_NAMES[here.capPhase || 0];
        this._set('cpl', e.captureLabel, 'text', ph ? `${here.name} · ${ph}${here.capRate > 0 ? ` ${here.capRate.toFixed(2)}×` : ''}` : here.name);
        if (this._c.cpv !== here.v) {
          this._c.cpv = here.v;
          e.captureBar.style.transform = `scaleX(${mine.toFixed(2)})`;
          e.captureBar.style.background = here.v < 0 ? CONFIG.teams[0].css : CONFIG.teams[1].css;
        }
      }
      if (this.debug) {
        const info = g.render.renderer.info;
        e.debug.textContent = `${this._fps.toFixed(0)} fps  res ${(g.render.resScale * g.render.devicePixelRatio).toFixed(2)}x\n` +
          `calls ${info.render.calls}  tris ${(info.render.triangles / 1000).toFixed(0)}k\n` +
          `chunks ${g.chunks.stats.visible}/${g.chunks.stats.built} built\n${g.render.qualityName}\n${g.ai.statsLine()}` + this._explain(g);
      }
    }
    if ((this._mapTimer -= dt) <= 0) { this._mapTimer = 0.125; this._drawMinimap(); }
  }

  /** ?debug: what the AI knows about the soldier or vehicle under the crosshair (refreshed twice a second). */
  _explain(g) {
    const now = performance.now();
    if (now - (this._explainAt || 0) > 500) {
      this._explainAt = now;
      const cam = g.render.camera, d = cam.getWorldDirection(this._explainDir || (this._explainDir = cam.position.clone()));
      const t = g.ai.explainAt(cam.position.x, cam.position.y, cam.position.z, d.x, d.y, d.z);
      this._explainText = t ? `\n--- under the crosshair ---\n${t}` : '';
    }
    return this._explainText || '';
  }

  /** HQ pips, and the phase banner: countdown to an exposed base, siege orders, incoming barrage. */
  _endgame(g, cap, s) {
    if (!cap.phase) return;
    const me = s.team, names = CONFIG.teams.map((t) => t.name);
    let text = '', alarm = false;
    for (let t = 0; t < 2; t++) {
      const left = cap.hqLeft(t), exposed = cap.phase[t] === 'siege';
      this._set(`hqe${t}`, this.el.hq[t], 'class', `hq${exposed ? ' exposed' : ''}`);
      this._hqPips[t].forEach((u, k) => this._set(`hqp${t}${k}`, u, 'class', k < left ? '' : 'down'));
      if (exposed) {
        text = t === me ? `OUR BASE IS EXPOSED · RETAKE ANY OBJECTIVE · HQ ${left}/4` : `${names[t]} BASE EXPOSED · DESTROY ITS HQ ${left}/4`;
        alarm = t === me;
      } else if (!text && cap._zeroFor[t] > 0) {
        const sec = Math.max(0, Math.ceil(SIEGE_DELAY - cap._zeroFor[t]));
        text = t === me ? `WE HOLD NO OBJECTIVE · BASE EXPOSED IN ${sec} s` : `${names[t]} HOLDS NO OBJECTIVE · BASE EXPOSED IN ${sec} s`;
        alarm = t === me;
      }
    }
    if (cap.barrage && g.time < cap.barrage.t + 8) { text = cap.barrage.team === me ? 'FRIENDLY ARTILLERY BARRAGE INBOUND' : 'ENEMY ARTILLERY — TAKE COVER'; alarm = cap.barrage.team !== me; }
    this._set('ph', this.el.phase, 'text', text);
    this._set('pha', this.el.phase, 'class', `${alarm ? 'alarm' : ''}${text ? '' : ' hidden'}`);
  }

  _drawMinimap() {
    const g = this.game, ctx = this._ctx, size = this.minimap.width, me = g.player;
    const t = g.map.terrain;
    const cx = me.alive ? me.pos.x : g.render.camera.position.x, cz = me.alive ? me.pos.z : g.render.camera.position.z;
    const scale = size / MAP_SPAN;
    const img = this._mapImage, k = img.width / t.size;
    ctx.fillStyle = '#1c3e54';
    ctx.fillRect(0, 0, size, size);
    ctx.drawImage(img, (cx - MAP_SPAN / 2 + t.half) * k, (cz - MAP_SPAN / 2 + t.half) * k, MAP_SPAN * k, MAP_SPAN * k, 0, 0, size, size);
    const px = (x) => (x - cx) * scale + size / 2, pz = (z) => (z - cz) * scale + size / 2;
    const teams = CONFIG.teams;

    // Territory (100 m frontline grid): translucent shading by owner, frontline contours from Marching Squares —
    // solid where the sides are in contact, dashed across quiet seams, a pulsing outline round encircled pockets.
    const F = g.ai && g.ai.frontline;
    if (F) {
      const cs = F.cell * scale, half = F.half;
      for (let i = 0; i < F.count; i++) {
        const o = F.owner(i);
        if (o < 0) continue;
        const x0 = px(-half + (i % F.n) * F.cell), z0 = pz(-half + ((i / F.n) | 0) * F.cell);
        if (x0 > size || z0 > size || x0 + cs < 0 || z0 + cs < 0) continue;
        ctx.fillStyle = o === 1 ? 'rgba(255, 122, 26, 0.12)' : 'rgba(20, 184, 166, 0.12)';
        ctx.fillRect(x0, z0, cs + 0.5, cs + 0.5);
      }
      const pulse = 0.45 + 0.4 * Math.sin(g.time * 4);
      for (const kind of [1, 0, 2]) {
        ctx.beginPath();
        let any = false;
        for (let k = 0; k < F.segN; k++) {
          if (F.segFlag[k] !== kind) continue;
          const x0 = px(F.seg[k * 4]), z0 = pz(F.seg[k * 4 + 1]), x1 = px(F.seg[k * 4 + 2]), z1 = pz(F.seg[k * 4 + 3]);
          if ((x0 < 0 && x1 < 0) || (z0 < 0 && z1 < 0) || (x0 > size && x1 > size) || (z0 > size && z1 > size)) continue;
          ctx.moveTo(x0, z0); ctx.lineTo(x1, z1); any = true;
        }
        if (!any) continue;
        ctx.lineWidth = 2;
        ctx.setLineDash(kind === 0 ? [4, 4] : []);
        ctx.strokeStyle = kind === 2 ? `rgba(255, 70, 70, ${pulse.toFixed(2)})` : kind === 1 ? 'rgba(255, 245, 225, 0.9)' : 'rgba(255, 245, 225, 0.55)';
        ctx.stroke();
      }
      ctx.setLineDash([]);
    }

    // Operation zones (real operations of our side): dashed = forming up / line of departure, solid = objective.
    const cmd = g.ai && g.ai.commanders ? g.ai.commanders[me.team] : null;
    if (cmd) {
      cmd.zones(this._zones);
      const COL = ['rgba(255,140,60,0.95)', 'rgba(190,120,255,0.95)', 'rgba(255,215,90,0.95)'];
      ctx.lineWidth = 2; ctx.font = 'bold 10px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      for (const zn of this._zones) {
        const x = px(zn.x), z = pz(zn.z), r = Math.max(5, zn.r * scale);
        if (x < -r || z < -r || x > size + r || z > size + r) continue;
        ctx.strokeStyle = COL[zn.purpose];
        ctx.setLineDash(zn.kind === 2 ? [] : zn.kind === 1 ? [2, 3] : [6, 4]);
        ctx.beginPath(); ctx.arc(x, z, r, 0, 6.283); ctx.stroke();
        ctx.fillStyle = COL[zn.purpose];
        ctx.fillText(`${zn.kind === 0 ? 'A' : zn.kind === 1 ? 'L' : ''}${zn.id}`, x, z - r - 6);
      }
      ctx.setLineDash([]);
      // Transports tied to a squad: drop point while carrying, waiting point on standby; open extraction requests.
      const orch = g.ai.orchestrator;
      for (const v of g.vehicles.list) {
        if (!v.alive || v.team !== me.team) continue;
        const m = orch.manifests[v.id];
        if (m.supports < 0 && m.squadId < 0) continue;
        const tx = m.mode === 2 ? m.dismountX : m.supportState === 'standby' ? m.waitX : NaN, tz = m.mode === 2 ? m.dismountZ : m.waitZ;
        if (Number.isNaN(tx)) continue;
        ctx.strokeStyle = 'rgba(120,230,255,0.95)'; ctx.lineWidth = 1.5;
        ctx.strokeRect(px(tx) - 3.5, pz(tz) - 3.5, 7, 7);
      }
      // Planned convoys: members linked in order (dashed while forming up), chevron at the head.
      const list = g.vehicles.list;
      for (const c of g.ai.squads.convoys) {
        if (!c.active || c.team !== me.team || c.count < 2) continue;
        ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.lineWidth = 1.5; ctx.setLineDash(c.state === 'assembling' ? [3, 3] : []);
        ctx.beginPath();
        for (let i = 0; i < c.count; i++) { const v = list[c.vehicles[i]]; if (i) ctx.lineTo(px(v.pos.x), pz(v.pos.z)); else ctx.moveTo(px(v.pos.x), pz(v.pos.z)); }
        ctx.stroke(); ctx.setLineDash([]);
        const lead = list[c.vehicles[0]], hx = px(lead.pos.x), hz = pz(lead.pos.z);
        const a = Math.atan2(c.destX - lead.pos.x, c.destZ - lead.pos.z);
        ctx.save(); ctx.translate(hx, hz); ctx.rotate(-a);
        ctx.beginPath(); ctx.moveTo(-5, 3); ctx.lineTo(0, 9); ctx.lineTo(5, 3); ctx.stroke(); ctx.restore();
      }
      for (const msg of g.ai.radio.messages) {
        if (msg.type !== 5 || msg.team !== me.team || (msg.state !== 1 && msg.state !== 2) || msg.expires < g.time) continue;
        const x = px(msg.x), z = pz(msg.z);
        ctx.strokeStyle = 'rgba(255,90,90,0.95)'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(x - 4, z - 4); ctx.lineTo(x + 4, z + 4); ctx.moveTo(x + 4, z - 4); ctx.lineTo(x - 4, z + 4); ctx.stroke();
      }
      if (!this._opsPanel.classList.contains('hidden') && (this._opsT = (this._opsT || 0) - 1) <= 0) {
        this._opsT = 4;
        const conv = g.ai.squads.convoyPanel(me.team);
        const fs = cmd.frontSnap;
        const front = F ? `\nFRONT: ${fs.contested} contested, ${fs.breach} rear breach, ${fs.pocket} pocket cells` : '';
        this._opsPanel.textContent = cmd.opsPanel() + front + (conv ? `\n${conv}` : '');
      }
    }

    for (const f of g.capture.flags) {
      // Off-map flags are pinned to the edge so the player always knows where objectives are.
      const x = clamp(px(f.x), 9, size - 9), z = clamp(pz(f.z), 9, size - 9);
      ctx.beginPath();
      ctx.arc(x, z, 8, 0, 6.283);
      ctx.fillStyle = f.owner < 0 ? 'rgba(235,235,235,0.9)' : teams[f.owner].css;
      ctx.fill();
      ctx.lineWidth = 2; ctx.strokeStyle = '#0b1014'; ctx.stroke();
      ctx.fillStyle = '#0b1014'; ctx.font = 'bold 11px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(f.name[0], x, z + 0.5);
    }
    // Exposed bases: their standing HQ buildings are marked.
    if (g.capture.phase) for (let t = 0; t < 2; t++) {
      if (g.capture.phase[t] !== 'siege') continue;
      for (const id of g.map.bases[t].hq) {
        const b = g.map.buildings[id];
        if (b.state >= 2) continue;
        ctx.fillStyle = teams[t].css; ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5;
        const x = clamp(px(b.x), 6, size - 6), z = clamp(pz(b.z), 6, size - 6);
        ctx.fillRect(x - 5, z - 5, 10, 10); ctx.strokeRect(x - 5, z - 5, 10, 10);
      }
    }
    for (const v of g.vehicles.list) {
      if (!v.alive || (v.occupied && v.team !== me.team && !this._visibleEnemy(v))) continue;
      ctx.fillStyle = v.occupied ? teams[v.team].css : '#e8e8e8';
      ctx.save();
      ctx.translate(px(v.pos.x), pz(v.pos.z));
      ctx.rotate(-v.yaw);
      const l = v.def.type === 'jeep' ? 7 : 10;
      ctx.fillRect(-3.5, -l / 2, 7, l);
      ctx.restore();
    }
    for (const s of g.soldiers) {
      if (!s.alive || s === me || s.vehicle) continue;
      if (s.team !== me.team && s.spotted <= 0) continue; // enemies only appear while revealed by gunfire
      ctx.fillStyle = teams[s.team].css;
      ctx.beginPath(); ctx.arc(px(s.pos.x), pz(s.pos.z), 3.2, 0, 6.283); ctx.fill();
    }
    if (me.alive) {
      ctx.save();
      ctx.translate(size / 2, size / 2);
      ctx.rotate(-me.yaw);
      ctx.fillStyle = '#fff'; ctx.strokeStyle = '#0b1014'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(0, 9); ctx.lineTo(5.5, -6); ctx.lineTo(0, -2.5); ctx.lineTo(-5.5, -6); ctx.closePath();
      ctx.fill(); ctx.stroke();
      ctx.restore();
    }
  }

  _visibleEnemy(v) {
    for (let i = 0; i < v.seats.length; i++) if (v.seats[i] && v.seats[i].spotted > 0) return true;
    return false;
  }
}
