/**
 * Upper-floor navigation: a small extension of the 2D infantry grid (not a replacement).
 *
 * The infantry grid knows only the ground floor. For every building with an upper level (a second storey, or the
 * flat roof of a one-storey building) this module keeps a fine local grid of that level, built from the
 * building's actual parts in its current damage state: where a floor (or roof) slab carries a soldier, minus
 * walls, parapets, the stairwell hole and the foot of the next flight up. The only connection between the ground
 * and that level is the first flight of stairs (a ramp), so a route is:
 *
 *   ground grid → approach point beside the foot of the stairs → foot → up the ramp → top → local grid → post
 *
 * and the reverse on the way out. Soldiers walk every metre of it with ordinary movement and physics (no
 * teleporting, no passing through slabs); the agent only steers along the waypoints. The level grid is rebuilt
 * lazily when the building's damage state changes, so a level whose stairs or floor are gone (ruined) is simply
 * not usable any more, and rubble or new holes reshape the routes. A route that makes no progress for 4 s is
 * abandoned (the building's upper level is then avoided by that soldier for a minute).
 */
// @ts-ignore -- plain JS module (no type declarations)
import { K, buildingParts, partSurface } from '../world/buildings.js';
import type { GameLike, SoldierLike } from './types';

const T = 0.25;
const CELL = 0.4;
/** Clearance kept from walls, parapets and holes (body radius plus a margin). */
const CLEAR = 0.35;

interface Level {
  bi: number;
  /** The stairs cannot be reached from outside on the ground grid (never usable). */
  cut: boolean;
  /** Damage state the grid was built for (-1: never). */
  state: number;
  usable: boolean;
  /** Height of the level above the building's base. */
  y: number;
  gx0: number; gz0: number; nx: number; nz: number;
  free: Uint8Array;
  /** Stairs (flight 0), local: x of the ramp centre line, foot and top z, approach point on the ground. */
  xm: number; zf: number; zt: number; ax: number; az: number;
  /** Last point on the ground beside the foot of the stairs (walked to directly from the approach point). */
  bx: number; bz: number;
  /** Fighting posts on the level (local position and outward normal), computed for the intact building. */
  posts: { x: number; z: number; ox: number; oz: number }[];
}

/** Agent fields this module reads and writes (the JS AIAgent carries them). */
export interface FloorAgent {
  s: SoldierLike;
  goalX: number; goalZ: number; hasGoal: boolean;
  /** Building whose upper level the current goal is on (-1: ground). Set by the tactical layer. */
  upB: number;
  flMode: number; flB: number; flPts: Float32Array; flN: number; flI: number;
  flT: number; flBest: number; flFail: number; flGX: number; flGZ: number;
  flBadB: number; flBadUntil: number;
}

const QUEUE = new Int32Array(16384);
const PREV = new Int32Array(16384);
const PATH = new Float32Array(256);

export class FloorRoutes {
  private readonly game: GameLike;
  readonly buildings: any[];
  readonly levels: (Level | null)[];
  readonly stats = { routesUp: 0, routesDown: 0, routesFloor: 0, arrived: 0, aborted: 0, stuckUp: 0, rebuilt: 0, levels: 0, posts: 0, invalidated: 0, noApproach: 0 };

  constructor(game: GameLike, buildings: any[]) {
    this.game = game;
    this.buildings = buildings;
    this.levels = buildings.map((b, bi) => this.makeLevel(b, bi));
    // The stairs' approach point must be reachable on the ground grid from outside the building (quayside
    // buildings over water, for instance, are not): otherwise the level is left out.
    const nav = (game as any).nav, P = new Float32Array(512);
    for (const L of this.levels) {
      if (!L || !L.usable || !nav || !nav.findPath) continue;
      const b = this.buildings[L.bi];
      this.world(b, L.ax, L.az, P, 0);
      const ax = P[0], az = P[1];
      let ok = false;
      for (const op of b.openings) {
        if (op.kind !== 'door' || op.floor !== 0 || ok) continue;
        const lx = op.side === 2 ? b.w / 2 + 3 : op.side === 3 ? -b.w / 2 - 3 : op.u, lz = op.side === 0 ? b.d / 2 + 3 : op.side === 1 ? -b.d / 2 - 3 : op.u;
        this.world(b, lx, lz, P, 0);
        if (nav.blocked(P[0], P[1])) continue;
        const n = nav.findPath(P[0], P[1], ax, az, false, P);
        // The path must actually end at the approach point and enter through the building (not stop outside a wall).
        ok = n > 0 && Math.hypot(P[(n - 1) * 2] - ax, P[(n - 1) * 2 + 1] - az) < 0.5 && !nav._partial;
      }
      if (!ok) { L.usable = false; L.cut = true; this.stats.noApproach++; }
    }
    for (const L of this.levels) if (L && L.usable) { this.stats.levels++; this.stats.posts += L.posts.length; }
  }

  /** Building has an upper level reachable by stairs (by its layout; see usable() for its current state). */
  private hasLevel(b: any): boolean {
    if (!b || b.deck || b.type === 'custom' || b.type === 'bridge' || b.name === 'tunnel' || b.name === 'pier' || b.roof === 'open') return false;
    return b.floors >= 2 || (b.floors === 1 && b.roof === 'flat');
  }

  private makeLevel(b: any, bi: number): Level | null {
    if (!this.hasLevel(b)) return null;
    const run = Math.min(b.d - 2 * T - 1.6, b.fh * 1.75);
    const x0 = -b.w / 2 + T, x1 = x0 + 1.3, z0 = -b.d / 2 + T + 0.6, z1 = z0 + run;
    const nx = Math.ceil((b.w - 2 * T) / CELL), nz = Math.ceil((b.d - 2 * T) / CELL);
    if (nx * nz > QUEUE.length) return null;
    const L: Level = {
      bi, cut: false, state: -1, usable: false, y: b.fh, gx0: -b.w / 2 + T, gz0: -b.d / 2 + T, nx, nz, free: new Uint8Array(nx * nz),
      xm: (x0 + x1) / 2, zf: z0 + 0.3, zt: z1 + 0.7, ax: x1 + 0.8, az: Math.min(z0 + 2.5, (z0 + z1) / 2), bx: x1 + 0.7, bz: z0 + 0.35, posts: [],
    };
    this.rebuild(L);
    if (!L.usable) return L;
    // Posts: inside every window of the level (or along the parapet of a flat roof), reachable from the stairs.
    const top = this.cellAt(L, L.xm, L.zt);
    const reach = this.flood(L, top);
    const add = (x: number, z: number, ox: number, oz: number): void => {
      const c = this.nearestFree(L, x, z, 0.6);
      if (c < 0 || !reach[c]) return;
      const cx = L.gx0 + ((c % L.nx) + 0.5) * CELL, cz = L.gz0 + (Math.floor(c / L.nx) + 0.5) * CELL;
      // Not on the stairs' landing.
      if (Math.abs(cx - L.xm) < 1.2 && Math.abs(cz - L.zt) < 1.2) return;
      for (const p of L.posts) if ((p.x - cx) ** 2 + (p.z - cz) ** 2 < 2.2 * 2.2) return;
      L.posts.push({ x: cx, z: cz, ox, oz });
    };
    const inset = 0.95;
    if (b.floors >= 2) {
      for (const op of b.openings) {
        if (op.kind !== 'window' || op.floor !== 1) continue;
        if (op.side === 0) add(op.u, b.d / 2 - inset, 0, 1);
        else if (op.side === 1) add(op.u, -b.d / 2 + inset, 0, -1);
        else if (op.side === 2) add(b.w / 2 - inset, op.u, 1, 0);
        else add(-b.w / 2 + inset, op.u, -1, 0);
      }
    } else {
      for (const f of [-0.3, 0.3]) {
        add(f * b.w, b.d / 2 - inset, 0, 1); add(f * b.w, -b.d / 2 + inset, 0, -1);
        add(b.w / 2 - inset, f * b.d, 1, 0); add(-b.w / 2 + inset, f * b.d, -1, 0);
      }
    }
    return L;
  }

  /** Rebuilds a level's grid from the building's parts in its current damage state. */
  private rebuild(L: Level): void {
    const b = this.buildings[L.bi];
    L.state = b.state;
    L.free.fill(0);
    L.usable = false;
    if (b.state >= 2 || L.cut) return;
    const parts = buildingParts(b);
    const y = L.y;
    const slabs: any[] = [], walls: any[] = [], ramps: any[] = [];
    let flight0 = false;
    for (const p of parts) {
      if ((p.k === K.FLOOR || p.k === K.ROOF) && !p.rx && !p.rz && Math.abs(p.y + p.hy - y) < 0.3) slabs.push(p);
      else if ((p.k === K.WALL || p.k === K.PILLAR) && !p.rx && !p.rz && p.y + p.hy > y + 0.45 && p.y - p.hy < y + 1.7) walls.push(p);
      else if (p.k === K.RAMP && p.rx) {
        if (p.y < y) flight0 = flight0 || Math.abs(p.x - L.xm) < 0.3; else ramps.push(p);
      }
    }
    if (!flight0 || !slabs.length) return;
    const supported = (x: number, z: number): boolean => {
      for (const p of slabs) if (partSurface(p, x, z) !== -Infinity) return true;
      return false;
    };
    for (let j = 0; j < L.nz; j++) for (let i = 0; i < L.nx; i++) {
      const x = L.gx0 + (i + 0.5) * CELL, z = L.gz0 + (j + 0.5) * CELL;
      if (!supported(x, z) || !supported(x + CLEAR, z) || !supported(x - CLEAR, z) || !supported(x, z + CLEAR) || !supported(x, z - CLEAR)) continue;
      let ok = true;
      for (const p of walls) if (Math.abs(x - p.x) < p.hx + CLEAR && Math.abs(z - p.z) < p.hz + CLEAR) { ok = false; break; }
      // The foot of the next flight up (stepping onto it would take the soldier further up).
      if (ok) for (const p of ramps) { const run = Math.abs(p.hz * Math.cos(p.rx)); if (Math.abs(x - p.x) < p.hx + CLEAR && Math.abs(z - p.z) < run + CLEAR) { ok = false; break; } }
      if (ok) L.free[j * L.nx + i] = 1;
    }
    // The top of the stairs must open onto the level.
    const top = this.cellAt(L, L.xm, L.zt);
    L.usable = top >= 0 && L.free[top] === 1;
    if (!L.usable) {
      const alt = this.cellAt(L, L.xm, L.zt + 0.4);
      if (alt >= 0 && L.free[alt]) { L.zt += 0.4; L.usable = true; }
    }
  }

  /** Level of building bi, rebuilt if its damage state changed; null when it has none or it is unusable. */
  level(bi: number): Level | null {
    const L = bi >= 0 ? this.levels[bi] : null;
    if (!L) return null;
    if (L.state !== this.buildings[bi].state) {
      const was = L.usable;
      this.rebuild(L); this.stats.rebuilt++;
      if (was && !L.usable) this.stats.invalidated++;
    }
    return L.usable ? L : null;
  }

  /** Whether building bi's upper level can be used now (by this agent, if given). */
  ok(bi: number, a?: FloorAgent): boolean {
    if (a && a.flBadB === bi && this.game.time < a.flBadUntil) return false;
    return this.level(bi) !== null;
  }

  /** World height of building bi's upper level. */
  levelY(bi: number): number { const b = this.buildings[bi]; return (b.y || 0) + (this.levels[bi] ? this.levels[bi]!.y : b.fh); }

  /** Is the soldier on building bi's upper level (above the stairs' midpoint, within the footprint)? */
  isUp(bi: number, s: SoldierLike): boolean {
    const b = this.buildings[bi], L = this.levels[bi];
    if (!b || !L || s.pos.y - (b.y || 0) < L.y * 0.6) return false;
    this.local(b, s.pos.x, s.pos.z, LO);
    return Math.abs(LO[0]) < b.w / 2 && Math.abs(LO[1]) < b.d / 2;
  }

  private local(b: any, x: number, z: number, out: Float32Array): void {
    const dx = x - b.x, dz = z - b.z, c = Math.cos(b.rot), s = Math.sin(b.rot);
    out[0] = dx * c - dz * s; out[1] = dx * s + dz * c;
  }

  private world(b: any, lx: number, lz: number, out: Float32Array, k: number): void {
    const c = Math.cos(b.rot), s = Math.sin(b.rot);
    out[k] = b.x + lx * c + lz * s; out[k + 1] = b.z - lx * s + lz * c;
  }

  private cellAt(L: Level, x: number, z: number): number {
    const i = Math.floor((x - L.gx0) / CELL), j = Math.floor((z - L.gz0) / CELL);
    return i < 0 || j < 0 || i >= L.nx || j >= L.nz ? -1 : j * L.nx + i;
  }

  private nearestFree(L: Level, x: number, z: number, r: number): number {
    let best = -1, bd = r * r;
    const c = this.cellAt(L, x, z);
    if (c >= 0 && L.free[c]) return c;
    const k = Math.ceil(r / CELL);
    const i0 = Math.floor((x - L.gx0) / CELL), j0 = Math.floor((z - L.gz0) / CELL);
    for (let j = j0 - k; j <= j0 + k; j++) for (let i = i0 - k; i <= i0 + k; i++) {
      if (i < 0 || j < 0 || i >= L.nx || j >= L.nz || !L.free[j * L.nx + i]) continue;
      const d = (L.gx0 + (i + 0.5) * CELL - x) ** 2 + (L.gz0 + (j + 0.5) * CELL - z) ** 2;
      if (d < bd) { bd = d; best = j * L.nx + i; }
    }
    return best;
  }

  /** Breadth-first search over the level grid from cell `from`; fills PREV; returns reached flags. */
  private flood(L: Level, from: number, to = -1): Uint8Array {
    const seen = new Uint8Array(L.nx * L.nz);
    if (from < 0 || !L.free[from]) return seen;
    let h = 0, t = 0;
    QUEUE[t++] = from; seen[from] = 1; PREV[from] = -1;
    while (h < t) {
      const c = QUEUE[h++];
      if (c === to) break;
      const i = c % L.nx, j = (c - i) / L.nx;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        if (!di && !dj) continue;
        const ii = i + di, jj = j + dj;
        if (ii < 0 || jj < 0 || ii >= L.nx || jj >= L.nz) continue;
        const n = jj * L.nx + ii;
        if (seen[n] || !L.free[n]) continue;
        // No corner cutting.
        if (di && dj && (!L.free[j * L.nx + ii] || !L.free[jj * L.nx + i])) continue;
        seen[n] = 1; PREV[n] = c; QUEUE[t++] = n;
      }
    }
    return seen;
  }

  /** Straight walk between two local points stays on free cells. */
  private clear(L: Level, ax: number, az: number, bx: number, bz: number): boolean {
    const d = Math.hypot(bx - ax, bz - az), n = Math.max(1, Math.ceil(d / 0.2));
    for (let k = 0; k <= n; k++) {
      const c = this.cellAt(L, ax + (bx - ax) * (k / n), az + (bz - az) * (k / n));
      if (c < 0 || !L.free[c]) return false;
    }
    return true;
  }

  /**
   * Path on the level between two local points (string-pulled), appended to PATH as local x, z pairs starting at
   * index `k`. Returns the new length, or -1 when there is no way.
   */
  private levelPath(L: Level, ax: number, az: number, bx: number, bz: number, k: number): number {
    const from = this.nearestFree(L, ax, az, 1.2), to = this.nearestFree(L, bx, bz, 1.2);
    if (from < 0 || to < 0) return -1;
    const seen = this.flood(L, from, to);
    if (!seen[to]) return -1;
    let n = 0;
    const cells = QUEUE; // reuse as scratch (flood is done)
    for (let c = to; c >= 0; c = PREV[c]) cells[n++] = c;
    // Reverse into points, string-pulling: keep a point only when the straight line from the last kept point
    // to the next one leaves the free cells.
    const cx = (c: number) => L.gx0 + ((c % L.nx) + 0.5) * CELL, cz = (c: number) => L.gz0 + (Math.floor(c / L.nx) + 0.5) * CELL;
    let lx = ax, lz = az;
    for (let m = n - 2; m >= 0; m--) {
      const nxt = cells[m];
      const px = cx(cells[m + 1]), pz = cz(cells[m + 1]);
      if (!this.clear(L, lx, lz, cx(nxt), cz(nxt)) && k < PATH.length - 4) { PATH[k++] = px; PATH[k++] = pz; lx = px; lz = pz; }
    }
    PATH[k++] = cx(to); PATH[k++] = cz(to);
    return k;
  }

  /**
   * Steering for an agent with a goal. Returns 0: not involved (ordinary ground navigation to the goal);
   * 1: walk straight to out[0], out[1] (on the stairs / the upper level); 2: navigate on the ground to
   * out[0], out[1] (the stairs' approach point) instead of the goal.
   */
  steer(a: FloorAgent, out: Float32Array): number {
    const s = a.s, time = this.game.time;
    const want = a.upB >= 0 && this.ok(a.upB, a) ? a.upB : -1;
    const up = a.flB >= 0 && this.isUp(a.flB, s);
    const routing = a.flMode === 2 || a.flMode === 3;
    if (!up && !routing) a.flB = -1;
    if (a.flMode === 2 && (want !== a.flB || (a.goalX - a.flGX) ** 2 + (a.goalZ - a.flGZ) ** 2 > 0.8 * 0.8)) {
      // The goal changed under way: stay on the level and re-plan if still up there / wanted there.
      if (want !== a.flB && !up) {
        // Still on the stairs or at their foot, going up for nothing: come back down the way it came.
        if (a.flB >= 0 && s.pos.y - (this.buildings[a.flB].y || 0) > 0.5) return this.startDown(a, out, time);
        a.flMode = 0; a.flB = -1;
      } else a.flMode = 0;
    }
    if (a.flMode === 3 && want >= 0 && want === a.flB && up) a.flMode = 0;
    if (a.flMode === 2 || a.flMode === 3) return this.follow(a, out, time);
    if (up) {
      const b = this.buildings[a.flB], L = this.level(a.flB);
      this.local(b, a.goalX, a.goalZ, LO);
      const inside = Math.abs(LO[0]) < b.w / 2 - T && Math.abs(LO[1]) < b.d / 2 - T;
      if (L && (want === a.flB || (want < 0 && inside))) {
        // Moving about on the level.
        this.local(b, s.pos.x, s.pos.z, LS);
        const k = this.levelPath(L, LS[0], LS[1], LO[0], LO[1], 0);
        if (k > 0) { this.setRoute(a, b, k, 2, time); this.stats.routesFloor++; return this.follow(a, out, time); }
      }
      return this.startDown(a, out, time);
    }
    if (want < 0) { a.flMode = 0; return 0; }
    // On the ground, the goal is upstairs: to the foot of the stairs on the ground grid, then up.
    const b = this.buildings[want], L = this.level(want)!;
    this.world(b, L.ax, L.az, out, 0);
    const dA = Math.hypot(out[0] - s.pos.x, out[1] - s.pos.z);
    if (dA > 0.8) {
      // Walking to the stairs on the ground grid; no progress for 10 s: the way in is blocked, give it up.
      if (a.flMode !== 1) { a.flMode = 1; a.flT = time; a.flBest = dA; }
      else if (dA < a.flBest - 0.5) { a.flBest = dA; a.flT = time; }
      else if (time - a.flT > 10) { a.flBadB = want; a.flBadUntil = time + 60; this.stats.aborted++; a.flMode = 0; return 0; }
      return 2;
    }
    this.local(b, a.goalX, a.goalZ, LO);
    let k = 0;
    PATH[k++] = L.bx; PATH[k++] = L.bz; PATH[k++] = L.xm; PATH[k++] = L.zf; PATH[k++] = L.xm; PATH[k++] = L.zt;
    k = this.levelPath(L, L.xm, L.zt, LO[0], LO[1], k);
    if (k < 0) { a.flBadB = want; a.flBadUntil = time + 60; this.stats.aborted++; a.flMode = 0; return 0; }
    a.flB = want;
    this.setRoute(a, b, k, 2, time);
    this.stats.routesUp++;
    return this.follow(a, out, time);
  }

  /** Down the stairs from wherever the soldier is on the level (or on the stairs) to the approach point. */
  private startDown(a: FloorAgent, out: Float32Array, time: number): number {
    const b = this.buildings[a.flB], L = this.levels[a.flB]!, s = a.s;
    let k = 0;
    this.local(b, s.pos.x, s.pos.z, LS);
    const onStairs = Math.abs(LS[0] - L.xm) < 0.9 && LS[1] < L.zt - 0.3;
    if (!onStairs) {
      if (L.usable && L.state === b.state) k = this.levelPath(L, LS[0], LS[1], L.xm, L.zt, 0);
      if (k < 0) k = 0;
      PATH[k++] = L.xm; PATH[k++] = L.zt;
    }
    PATH[k++] = L.xm; PATH[k++] = L.zf; PATH[k++] = L.bx; PATH[k++] = L.bz; PATH[k++] = L.ax; PATH[k++] = L.az;
    this.setRoute(a, b, k, 3, time);
    this.stats.routesDown++;
    return this.follow(a, out, time);
  }

  private setRoute(a: FloorAgent, b: any, k: number, mode: number, time: number): void {
    const n = Math.min(k, a.flPts.length) >> 1;
    for (let i = 0; i < n; i++) this.world(b, PATH[i * 2], PATH[i * 2 + 1], a.flPts, i * 2);
    a.flN = n; a.flI = 0; a.flMode = mode; a.flT = time; a.flBest = 1e9; a.flGX = a.goalX; a.flGZ = a.goalZ;
  }

  private follow(a: FloorAgent, out: Float32Array, time: number): number {
    const s = a.s;
    // Arrived, then jostled off the spot: step back onto it.
    if (a.flI >= a.flN && a.flMode === 2 && a.flN > 0) {
      const x = a.flPts[(a.flN - 1) * 2], z = a.flPts[(a.flN - 1) * 2 + 1];
      if ((x - s.pos.x) ** 2 + (z - s.pos.z) ** 2 > 0.8 * 0.8) { a.flI = a.flN - 1; a.flT = time; a.flBest = 1e9; }
    }
    while (a.flI < a.flN) {
      const x = a.flPts[a.flI * 2], z = a.flPts[a.flI * 2 + 1];
      const d = Math.hypot(x - s.pos.x, z - s.pos.z), last = a.flI === a.flN - 1;
      if (d < (last ? 0.3 : 0.45)) {
        a.flI++; a.flBest = 1e9; a.flT = time;
        if (last && a.flMode === 2) { this.stats.arrived++; a.flFail = 0; }
        continue;
      }
      if (d < a.flBest - 0.25) { a.flBest = d; a.flT = time; }
      else if (time - a.flT > 4) return this.stuck(a, out, time);
      out[0] = x; out[1] = z;
      return 1;
    }
    // Down: back on the ground grid.
    if (a.flMode === 3) { a.flMode = 0; a.flB = -1; a.flFail = 0; return 0; }
    // At the post: stand there.
    out[0] = a.flPts[(a.flN - 1) * 2]; out[1] = a.flPts[(a.flN - 1) * 2 + 1];
    return 1;
  }

  /** No progress for 4 s on a route (blocked by people, rubble, a changed building). */
  private stuck(a: FloorAgent, out: Float32Array, time: number): number {
    const s = a.s;
    a.flFail++;
    const b = a.flB >= 0 ? this.buildings[a.flB] : null;
    const high = b !== null && s.pos.y - (b.y || 0) > 0.5;
    if (!high) {
      // Never got onto the stairs: avoid this building's upper level for a minute; ground navigation resumes.
      this.stats.aborted++;
      if (a.flB >= 0) { a.flBadB = a.flB; a.flBadUntil = time + 60; }
      a.flMode = 0; a.flB = -1; a.flFail = 0;
      return 0;
    }
    if (a.flFail >= 3) {
      // Up there and cannot get anywhere: stay put (the tactical layer sees the post as unreachable).
      this.stats.stuckUp++;
      a.flBadB = a.flB; a.flBadUntil = time + 60;
      a.flMode = 0; a.flFail = 0;
      out[0] = s.pos.x; out[1] = s.pos.z;
      return 1;
    }
    // Re-plan from here (a comrade in the way moves on; a new hole is routed around).
    a.flT = time; a.flBest = 1e9;
    if (a.flMode === 3 || this.level(a.flB!) === null) return this.startDown(a, out, time);
    a.flMode = 0;
    return this.steer(a, out);
  }

  /** Post of building bi's level k in world coordinates (x, z, outward normal x, z). */
  postWorld(bi: number, k: number, out: Float32Array): void {
    const b = this.buildings[bi], p = this.levels[bi]!.posts[k], c = Math.cos(b.rot), s = Math.sin(b.rot);
    out[0] = b.x + p.x * c + p.z * s; out[1] = b.z - p.x * s + p.z * c;
    out[2] = p.ox * c + p.oz * s; out[3] = -p.ox * s + p.oz * c;
  }
}

const LO = new Float32Array(2);
const LS = new Float32Array(2);
