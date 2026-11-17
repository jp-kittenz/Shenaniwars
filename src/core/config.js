/**
 * Global tunables. Everything gameplay- or budget-related lives here so that
 * balancing never requires touching system code.
 */

/**
 * @typedef {Object} QualityTier
 * @property {number} maxPixelRatio  Upper bound for the dynamic-resolution scaler.
 * @property {number} minPixelRatio  Lower bound for the dynamic-resolution scaler.
 * @property {number} cascades       CSM cascade count (0 = shadows off).
 * @property {number} shadowMapSize  Per-cascade shadow map resolution.
 * @property {number} shadowFar      Max shadow distance in metres.
 * @property {boolean} post          Enables the HDR post chain (bloom/grade/vignette).
 * @property {boolean} ssao          Depth-based ambient occlusion in the composite pass.
 * @property {number} msaa           MSAA samples on the scene target.
 * @property {number} viewDist       Camera far plane / chunk visibility distance.
 * @property {number} hiLodDist      Distance under which chunks use full detail.
 * @property {number} botsPerTeam    AI soldiers per team.
 * @property {number} particles      Particle pool capacity.
 */

/** @type {Record<'low'|'medium'|'high', QualityTier>} */
export const QUALITY = {
  low: {
    maxPixelRatio: 1, minPixelRatio: 0.6, cascades: 0, shadowMapSize: 512, shadowFar: 0,
    post: false, ssao: false, msaa: 0, viewDist: 380, hiLodDist: 110, botsPerTeam: 9, particles: 512,
  },
  medium: {
    maxPixelRatio: 1.5, minPixelRatio: 0.7, cascades: 2, shadowMapSize: 1024, shadowFar: 110,
    post: true, ssao: false, msaa: 0, viewDist: 520, hiLodDist: 150, botsPerTeam: 12, particles: 1024,
  },
  high: {
    maxPixelRatio: 2, minPixelRatio: 0.8, cascades: 3, shadowMapSize: 1024, shadowFar: 170,
    post: true, ssao: true, msaa: 4, viewDist: 700, hiLodDist: 200, botsPerTeam: 15, particles: 2048,
  },
};

export const CONFIG = {
  seed: 20261,
  fixedDt: 1 / 60,
  maxFrameDt: 0.1,
  world: {
    size: 768,        // metres, square, centred on origin
    heightRes: 2,     // metres per heightmap sample
    chunkSize: 64,    // metres per streaming chunk
    navCell: 4,       // metres per navigation cell
    waterLevel: 0,
  },
  teams: [
    { name: 'TEAL', color: 0x1fb8a8, css: '#1fb8a8' },
    { name: 'EMBER', color: 0xf2762e, css: '#f2762e' },
  ],
  match: {
    tickets: 150,
    captureRadius: 16,
    captureTime: 9,       // seconds for one uncontested soldier to flip a neutral flag
    bleedInterval: 4,     // seconds per ticket bled from the team holding fewer flags
    respawnTime: 5,
    vehicleRespawnTime: 35,
    squadSize: 4,
  },
  soldier: {
    walkSpeed: 4.6,
    sprintSpeed: 7.2,
    radius: 0.42,
    eyeHeight: 1.62,
    jumpSpeed: 5.2,
    gravity: 15,
    health: 100,
    regenDelay: 6,
    regenRate: 12,
  },
  ai: {
    thinkInterval: 0.22,
    viewRange: 170,
    fovCos: Math.cos((115 * Math.PI) / 360), // half-angle of a 115° cone
    hearRange: 90,
    pathsPerFrame: 3,
    damageVsPlayer: 0.55,
  },
};

/** Collision groups (Rapier 16/16 bit membership/filter). */
export const GROUP = {
  WORLD: 0x0001,
  VEHICLE: 0x0002,
  WRECK: 0x0004,
};

/**
 * Picks a starting quality tier from coarse device signals. The dynamic
 * resolution scaler then fine-tunes at runtime.
 * @returns {'low'|'medium'|'high'}
 */
export function detectQuality() {
  const nav = typeof navigator !== 'undefined' ? navigator : /** @type {any} */ ({});
  const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(nav.userAgent || '') || (nav.maxTouchPoints || 0) > 1;
  const cores = nav.hardwareConcurrency || 4;
  const mem = /** @type {any} */ (nav).deviceMemory || 4;
  if (!mobile) return cores >= 8 ? 'high' : 'medium';
  if (cores >= 8 && mem >= 6) return 'medium';
  return cores >= 6 && mem >= 4 ? 'medium' : 'low';
}
