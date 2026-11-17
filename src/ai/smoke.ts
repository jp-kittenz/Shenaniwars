import type { GameLike } from './types.ts';

/**
 * Smoke screens: a fixed pool of spheres that block AI line of sight and
 * emit visual smoke particles while active.
 */
export class SmokeField {
  readonly capacity = 24;
  readonly x = new Float32Array(24);
  readonly y = new Float32Array(24);
  readonly z = new Float32Array(24);
  readonly r = new Float32Array(24);
  readonly until = new Float32Array(24);
  private next = 0;
  private emitTimer = 0;
  private puff = 0;

  /** Deploys a cloud; returns its slot. */
  deploy(x: number, y: number, z: number, radius: number, duration: number, time: number): number {
    // Reuse an expired slot first, else the oldest.
    let slot = -1;
    for (let i = 0; i < this.capacity; i++) if (this.until[i] < time) { slot = i; break; }
    if (slot < 0) { slot = this.next; this.next = (this.next + 1) % this.capacity; }
    this.x[slot] = x; this.y[slot] = y; this.z[slot] = z; this.r[slot] = radius; this.until[slot] = time + duration;
    return slot;
  }

  /** True when the segment a→b passes through an active cloud. */
  blocks(ax: number, ay: number, az: number, bx: number, by: number, bz: number, time: number): boolean {
    const dx = bx - ax, dy = by - ay, dz = bz - az;
    const len2 = dx * dx + dy * dy + dz * dz || 1e-6;
    for (let i = 0; i < this.capacity; i++) {
      if (this.until[i] < time) continue;
      // Clouds take a second to bloom and thin out in their last two seconds.
      const r = this.r[i] * Math.min(1, (this.until[i] - time) / 2);
      const px = this.x[i] - ax, py = this.y[i] - ay, pz = this.z[i] - az;
      let t = (px * dx + py * dy + pz * dz) / len2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const cx = ax + dx * t - this.x[i], cy = ay + dy * t - this.y[i], cz = az + dz * t - this.z[i];
      if (cx * cx + cy * cy + cz * cz < r * r) return true;
    }
    return false;
  }

  /** Emits particles for active clouds near the camera (fixed budget). */
  update(dt: number, time: number, game: GameLike): void {
    this.emitTimer -= dt;
    if (this.emitTimer > 0) return;
    this.emitTimer = 0.2;
    const cam = game.render.camera.position;
    for (let i = 0; i < this.capacity; i++) {
      if (this.until[i] < time) continue;
      const dx = this.x[i] - cam.x, dz = this.z[i] - cam.z;
      if (dx * dx + dz * dz > 400 * 400) continue;
      const r = this.r[i];
      for (let k = 0; k < 3; k++) {
        this.puff = (this.puff + 0.618034) % 1;
        const a = this.puff * Math.PI * 2, rr = r * (0.2 + 0.7 * ((this.puff * 7.13) % 1));
        game.particles.smoke(this.x[i] + Math.cos(a) * rr, this.y[i] + 0.4, this.z[i] + Math.sin(a) * rr, r * 0.45, 0.7);
      }
    }
  }

  reset(): void { this.until.fill(0); }
}
