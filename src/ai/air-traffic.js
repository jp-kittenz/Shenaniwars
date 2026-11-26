/**
 * Air traffic: each side's aircraft talk to each other through a tower that owns the runway.
 *
 *  - Who is landing, and who goes first? Every aircraft returning to the field asks to land. Priority: an aircraft in
 *    critical condition (an emergency: everyone else holds), then low fuel, then one carrying troops or cargo, then
 *    the rest in the order they called. Only the cleared one turns final; the others keep to the circuit and are told
 *    their number.
 *  - Who takes off first? Aircraft ready to go ask for departure; mission aircraft (a loaded transport, a strike jet
 *    with a target) go before routine sorties; one at a time, and never into landing traffic on short final.
 *  - Where are you? Aircraft in the air report their position, height and task now and then.
 *  - Who goes back to park? Landed aircraft report vacating the runway and taxiing to their hangar / stand.
 *  - Who is assigned to a mission? The tower announces new jobs (air assault, paradrop, CAS, supply drop).
 *  - Who is in critical condition? A badly damaged aircraft declares an emergency.
 *
 * The runway is a single resource per side: held by the cleared lander until it has slowed and left the strip, or
 * by the cleared departure until it is airborne. Pilots ask before turning final (mayLand) and before taxiing out
 * or rolling (mayDepart). Radio calls go to a log (the debug overlay and, for a player at the controls of an
 * aircraft, the air net panel in the HUD).
 */

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

export class AirTraffic {
  /** @param {any} game */
  constructor(game) {
    this.game = game;
    /** Per side: runway holder, landing and departure requests, call signs. */
    this.side = [0, 1].map(() => ({ holder: null, kind: '', since: 0, landQ: new Map(), depQ: new Map(), emergency: null, said: new Map() }));
    /** Radio log: { t, team, from, text }. */
    this.log = [];
    this._t = 0;
    this._pos = 0;
    this.stats = { landClear: 0, depClear: 0, emergencies: 0, holds: 0, calls: 0 };
    this._calls = new Map();
    this._tasks = new Map();
  }

  /** Short call sign: type + its number on the side ("Su-27 2"). */
  callsign(v) {
    let c = this._calls.get(v);
    if (!c) {
      const base = (v.def.label || v.def.type).split(' ')[0];
      let n = 1;
      for (const [o, s] of this._calls) if (o.def.type === v.def.type && o.spawn.team === v.spawn.team) n++;
      c = `${base} ${n}`;
      this._calls.set(v, c);
    }
    return c;
  }

  say(team, from, text) {
    const t = this.game.time;
    this.log.push({ t, team, from, text });
    if (this.log.length > 60) this.log.shift();
    this.stats.calls++;
  }

  /** Once per (aircraft, topic) every `gap` seconds: no radio spam. */
  _once(team, v, topic, gap, from, text) {
    const S = this.side[team], k = (v ? v.id : -1) + ':' + topic, t = this.game.time;
    if ((S.said.get(k) ?? -1e9) > t - gap) return;
    S.said.set(k, t);
    this.say(team, from, text);
  }

  _team(v) { return v.occupied ? v.team : v.spawn.team; }

  /** How urgent a landing is (higher first). */
  _landPriority(v) {
    const m = this.game.ai && this.game.ai.orchestrator.manifests[v.id];
    const hp = v.health / v.def.health;
    // Airborne traffic coming home outranks routine departures (it is burning fuel); emergencies outrank all.
    let p = 70;
    if (hp < 0.35) p += 100;
    const air = m && m.airSince >= 0 ? this.game.time - m.airSince : 0;
    p += Math.min(40, air / 6);
    const carried = v.seats.filter((s, i) => s && i > 0).length;
    if (carried > 0 || (m && m.cargoV >= 0)) p += 20;
    return p;
  }

  /** How urgent a departure is. */
  _depPriority(v, waited) {
    const m = this.game.ai && this.game.ai.orchestrator.manifests[v.id];
    let p = 30 + Math.min(25, waited * 0.25);
    if (m && (m.planeJob || m.msg || m.insertSquad >= 0)) p += 35;
    // Already sitting on the runway (lined up at the threshold, loaded): it goes first, it is in everyone's way.
    const rw = (this.game.map.runways || []).find((r) => r.team === this._team(v));
    if (rw) {
      const lat = (v.pos.x - rw.x0) * -rw.dz + (v.pos.z - rw.z0) * rw.dx, al = (v.pos.x - rw.x0) * rw.dx + (v.pos.z - rw.z0) * rw.dz;
      if (Math.abs(lat) < 14 && al > -30 && al < rw.len + 30) p += 500;
    }
    return p;
  }

  /**
   * Pilot asks to turn final. Registers the request; true once cleared (the runway is its own until it vacates).
   * @param {any} v
   */
  mayLand(v) {
    const team = this._team(v), S = this.side[team], t = this.game.time;
    if (!S.landQ.has(v)) {
      S.landQ.set(v, { t0: t, seen: t });
      const hp = v.health / v.def.health;
      const where = this._where(v);
      if (hp < 0.35) {
        S.emergency = v; this.stats.emergencies++;
        this.say(team, this.callsign(v), `Mayday, mayday — ${this.callsign(v)} badly damaged ${where}, request immediate landing!`);
      } else {
        const m = this.game.ai && this.game.ai.orchestrator.manifests[v.id], aloft = m && m.airSince >= 0 ? t - m.airSince : 0;
        this.say(team, this.callsign(v), `Tower, ${this.callsign(v)} ${where}, ${aloft > 240 ? 'low on fuel, ' : ''}inbound, request landing.`);
      }
    } else S.landQ.get(v).seen = t;
    return S.holder === v && S.kind === 'land';
  }

  /** Pilot asks to taxi out / roll. True once cleared. */
  mayDepart(v) {
    const team = this._team(v), S = this.side[team], t = this.game.time;
    // The tower works its own field: an aircraft on a forward airstrip far from it is on its own.
    const rw = (this.game.map.runways || []).find((r) => r.team === team);
    if (rw) {
      const al = (v.pos.x - rw.x0) * rw.dx + (v.pos.z - rw.z0) * rw.dz, lat = (v.pos.x - rw.x0) * -rw.dz + (v.pos.z - rw.z0) * rw.dx;
      if (Math.abs(lat) > 250 || al < -250 || al > rw.len + 250) return true;
    }
    if (!S.depQ.has(v)) {
      S.depQ.set(v, { t0: t, seen: t });
      const m = this.game.ai && this.game.ai.orchestrator.manifests[v.id];
      const job = m && m.planeJob ? (m.planeJob === 'para' ? 'paradrop' : m.planeJob === 'airland' ? 'air-landed lift' : 'supply drop')
        : m && m.insertSquad >= 0 ? 'troop lift' : m && m.msg ? 'strike' : 'patrol';
      this.say(team, this.callsign(v), `Tower, ${this.callsign(v)} ready, ${job}, request departure.`);
    } else S.depQ.get(v).seen = t;
    return S.holder === v && S.kind === 'dep';
  }

  /**
   * A transport loading on the runway (lined up at the threshold, ramp down): it keeps the runway it was cleared
   * onto until it rolls; nobody lands or lines up behind or in front of it meanwhile. Call every tick while loading.
   */
  loading(v) {
    const team = this._team(v), S = this.side[team];
    if (S.holder !== v) return;
    if (S.loadV !== v) this._once(team, v, 'loading', 120, 'Tower', `${this.callsign(v)} on the runway, loading. Runway closed, all traffic hold.`);
    S.loadV = v; S.loadSeen = this.game.time;
  }

  /** Where an aircraft is, relative to its own base: "3 km south-east of base, 250 m". */
  _where(v) {
    const b = this.game.map.bases && this.game.map.bases[this._team(v)];
    if (!b) return '';
    const dx = v.pos.x - b.x, dz = v.pos.z - b.z, d = Math.hypot(dx, dz);
    if (d < 400) return `over the field, ${Math.round(v.altitude / 10) * 10} m`;
    const a = Math.atan2(dx, -dz), k = ((Math.round(a / (Math.PI / 4)) % 8) + 8) % 8;
    return `${(d / 1000).toFixed(1)} km ${COMPASS[k]} of base, ${Math.round(v.altitude / 10) * 10} m`;
  }

  /** Mission assignment call (from the orchestrator / commander). */
  assigned(v, what) {
    // (A strike jet re-claiming the same kind of job every few seconds is not a new tasking.)
    const team = this._team(v), last = this._tasks.get(v);
    if (last && last.what === what && this.game.time - last.t < 90) return;
    if (last && this.game.time - last.t < 25) return;
    this._tasks.set(v, { what, t: this.game.time });
    this.say(team, 'Tower', `${this.callsign(v)}, tasked: ${what}.`);
  }

  /** @param {number} dt */
  update(dt) {
    const g = this.game, t = g.time;
    if ((this._t -= dt) > 0) return;
    this._t = 0.5;
    const list = g.vehicles.list, rws = g.map.runways || [];
    for (let team = 0; team < 2; team++) {
      const S = this.side[team];
      const rw = rws.find((r) => r.team === team);
      // Requests lapse when an aircraft stops asking (it landed, left, died, parked again).
      for (const Q of [S.landQ, S.depQ]) for (const [v, e] of Q) if (!v.alive || t - e.seen > 3) Q.delete(v);
      if (S.emergency && (!S.emergency.alive || !S.landQ.has(S.emergency))) S.emergency = null;
      // Release the runway: the lander slowed and off the strip (or gave up), the departure airborne.
      const h = S.holder;
      if (h) {
        const loading = S.loadV === h && t - S.loadSeen < 3;
        let free = !h.alive || t - S.since > (loading || S.loadV === h ? 330 : 150);
        if (S.kind === 'land') {
          const onStrip = rw && Math.abs((h.pos.x - rw.x0) * -rw.dz + (h.pos.z - rw.z0) * rw.dx) < 16;
          const landed = h.grounded > 0 && Math.abs(h.speed) < 12;
          if (landed && !onStrip) { free = true; this._once(team, h, 'vacate', 60, this.callsign(h), `${this.callsign(h)} clear of the runway, taxiing to parking.`); }
          if (!S.landQ.has(h) && !(h.grounded > 0)) free = true; // went round / diverted
        } else if (S.kind === 'dep') {
          if (h.altitude > 30 && !(h.grounded > 0)) { free = true; this._once(team, h, 'airborne', 60, this.callsign(h), `${this.callsign(h)} airborne.`); }
          if (!S.depQ.has(h) && h.grounded > 0 && Math.abs(h.speed) < 2 && t - S.since > 20) free = true; // stood down
          // Cleared but not moving (blocked on the way out): give the slot up and ask again later.
          if (loading) S.stillSince = 0;
          else if (h.grounded > 0 && Math.abs(h.speed) < 1) { if (!S.stillSince) S.stillSince = t; else if (t - S.stillSince > 30) { free = true; const e = S.depQ.get(h); if (e) e.t0 = t; } }
          else S.stillSince = 0;
        }
        if (free) { S.holder = null; S.kind = ''; S.stillSince = 0; S.loadV = null; }
      }
      // Clearances: the most urgent request goes next. An emergency lands first and holds every departure.
      if (!S.holder) {
        let bestL = null, bl = -1, bestD = null, bd = -1;
        for (const [v, e] of S.landQ) { const p = this._landPriority(v) + (t - e.t0) * 0.3; if (p > bl) { bl = p; bestL = v; } }
        for (const [v, e] of S.depQ) { const p = this._depPriority(v, t - e.t0); if (p > bd) { bd = p; bestD = v; } }
        if (S.emergency) { bestL = S.emergency; bl = 1e9; }
        if (bestL && (bl >= bd || !bestD)) {
          S.holder = bestL; S.kind = 'land'; S.since = t; this.stats.landClear++;
          this.say(team, 'Tower', `${this.callsign(bestL)}, cleared to land.${bestD ? ` ${this.callsign(bestD)}, hold short.` : ''}`);
          let n = 2;
          for (const [v] of S.landQ) if (v !== bestL) { this._once(team, v, 'num', 45, 'Tower', `${this.callsign(v)}, number ${n++}, continue in the circuit.`); this.stats.holds++; }
        } else if (bestD) {
          S.holder = bestD; S.kind = 'dep'; S.since = t; this.stats.depClear++;
          this.say(team, 'Tower', `${this.callsign(bestD)}, cleared for take-off.`);
          let n = 2;
          for (const [v] of S.depQ) if (v !== bestD) this._once(team, v, 'depnum', 45, 'Tower', `${this.callsign(v)}, number ${n++} for departure, hold short.`);
        }
      }
    }
    // Position reports and critical condition, now and then.
    this._pos -= 0.5;
    if (this._pos <= 0) {
      this._pos = 6;
      for (const v of list) {
        if (!v.alive || !v.isAircraft || !v.occupied || !v.driver || v.driver.isPlayer || v.altitude < 40) continue;
        const team = this._team(v), hp = v.health / v.def.health, m = g.ai && g.ai.orchestrator.manifests[v.id];
        if (hp < 0.35) this._once(team, v, 'crit', 40, this.callsign(v), `${this.callsign(v)}, hit and losing it, ${this._where(v)} — returning to base!`);
        else {
          const task = m && m.planeJob ? 'on the drop run' : m && m.insertSquad >= 0 ? 'with troops aboard' : m && m.msg ? 'on a strike' : v.def.kind === 'heli' ? 'on station' : 'on patrol';
          this._once(team, v, 'pos', 75, this.callsign(v), `${this.callsign(v)}, ${this._where(v)}, ${task}.`);
        }
      }
    }
  }

  /** Last radio calls of a side (newest last). */
  recent(team, n = 4) {
    const out = [];
    for (let i = this.log.length - 1; i >= 0 && out.length < n; i--) if (this.log[i].team === team) out.unshift(this.log[i]);
    return out;
  }
}
