import { TIMES, WEATHERS, blendTime, blendWeather } from './atmosphere.js';
import { clamp } from '../core/math.js';

/**
 * EnvironmentState: the one place that says what time it is and what the weather is doing, how bright the world
 * is and how far anyone can see. Renderer-side it drives the atmosphere presets (one interpolating sun / moon
 * directional light, a two-tone hemisphere light, sky + fog colour and distance, GPU rain, night emissives);
 * AI-side `visibilityRangeMeters` caps every line-of-sight check and `acquisitionFactor` slows target acquisition.
 *
 * Changes blend over `transitionSeconds` (sun angle and colours interpolate, rain fades in); an optional day
 * cycle walks through the seven times of day. Nothing here allocates per frame: blends are recomputed at 4 Hz
 * while a change is under way.
 */
export const TimeOfDay = /** @type {const} */ ({ SUNRISE: 'SUNRISE', MORNING: 'MORNING', NOON: 'NOON', SUNSET: 'SUNSET', DUSK: 'DUSK', NIGHT: 'NIGHT', MIDNIGHT: 'MIDNIGHT' });
export const Weather = /** @type {const} */ ({ CLEAR: 'CLEAR', OVERCAST: 'OVERCAST', LIGHT_RAIN: 'LIGHT_RAIN', HEAVY_STORM: 'HEAVY_STORM', COASTAL_FOG: 'COASTAL_FOG' });

const TIME_KEY = { SUNRISE: 'sunrise', MORNING: 'morning', NOON: 'midday', SUNSET: 'evening', DUSK: 'dusk', NIGHT: 'night', MIDNIGHT: 'midnight' };
const WEATHER_KEY = { CLEAR: 'clear', OVERCAST: 'overcast', LIGHT_RAIN: 'light_rain', HEAVY_STORM: 'storm', COASTAL_FOG: 'coastal_fog' };
const TIME_OF_KEY = Object.fromEntries(Object.entries(TIME_KEY).map(([k, v]) => [v, k]));
const WEATHER_OF_KEY = Object.fromEntries(Object.entries(WEATHER_KEY).map(([k, v]) => [v, k]));
const CYCLE = ['SUNRISE', 'MORNING', 'NOON', 'SUNSET', 'DUSK', 'NIGHT', 'MIDNIGHT'];

/** Weather Markov chain: row = current weather, weights for the next one (self-weight = it persists). */
const WEATHER_NEXT = {
  CLEAR: { CLEAR: 5, OVERCAST: 3, COASTAL_FOG: 1 },
  OVERCAST: { CLEAR: 3, OVERCAST: 3, LIGHT_RAIN: 3, COASTAL_FOG: 1 },
  LIGHT_RAIN: { OVERCAST: 3, LIGHT_RAIN: 3, HEAVY_STORM: 2, CLEAR: 1 },
  HEAVY_STORM: { LIGHT_RAIN: 4, HEAVY_STORM: 2, OVERCAST: 1 },
  COASTAL_FOG: { CLEAR: 3, OVERCAST: 2, COASTAL_FOG: 2 },
};
/** @param {string} w @param {number} r 0..1 */
export function nextWeather(w, r) {
  const row = WEATHER_NEXT[w] || WEATHER_NEXT.CLEAR;
  let tot = 0;
  for (const k in row) tot += row[k];
  r *= tot;
  for (const k in row) if ((r -= row[k]) < 0) return k;
  return w;
}

/** Clear-noon sight distance for the naked eye (m); everything else is a fraction of it. */
const BASE_VISIBILITY = 900;

export class EnvironmentState {
  /** @type {EnvironmentState|null} */
  static instance = null;

  /** @param {import('./game.js').Game} game */
  constructor(game) {
    EnvironmentState.instance = this;
    this.game = game;
    const atmo = game.atmosphere;
    this.timeOfDay = TIME_OF_KEY[atmo.time] || TimeOfDay.NOON;
    this.weather = WEATHER_OF_KEY[atmo.weather] || Weather.CLEAR;
    /** 0 pitch dark … 1 full daylight. */
    this.ambientLightFactor = 1;
    /** How far a soldier can see with the naked eye now (m); thermal sights see further at night. */
    this.visibilityRangeMeters = BASE_VISIBILITY;
    this.thermalRangeMeters = BASE_VISIBILITY;
    /** Multiplier on how fast targets are acquired (1 clear day … ~0.45 in fog at night). */
    this.acquisitionFactor = 1;
    this.transitionSeconds = 20;
    /** Live day cycle: seconds per time-of-day phase (0 = static). Default: a full day in ~18 minutes. */
    this.cycleSeconds = (18 * 60) / CYCLE.length;
    /** Live weather: weighted Markov transitions every few minutes (off while the player has pinned a weather). */
    this.autoWeather = true;
    this._wTimer = 150 + Math.random() * 120;
    this._from = null; this._to = null; this._wFrom = null; this._wTo = null;
    this._k = 1; this._timer = 0; this._cycleT = 0;
    this._refresh();
  }

  /** Begins a change of time of day (blended over `seconds`). */
  setTimeOfDay(tod, seconds = this.transitionSeconds) {
    if (!TIME_KEY[tod]) return;
    this._begin(tod, this.weather, seconds);
  }

  /** Begins a change of weather (blended over `seconds`). */
  setWeather(w, seconds = this.transitionSeconds) {
    if (!WEATHER_KEY[w]) return;
    this._begin(this.timeOfDay, w, seconds);
  }

  /** Follows a direct atmosphere change made elsewhere (the menu). */
  syncFromAtmosphere() {
    const atmo = this.game.atmosphere;
    this.timeOfDay = TIME_OF_KEY[atmo.time] || this.timeOfDay;
    this.weather = WEATHER_OF_KEY[atmo.weather] || this.weather;
    this._k = 1;
    this._refresh();
  }

  _begin(tod, w, seconds) {
    const atmo = this.game.atmosphere;
    this._from = atmo.T || TIMES[TIME_KEY[this.timeOfDay]];
    this._wFrom = atmo.W || WEATHERS[WEATHER_KEY[this.weather]];
    this.timeOfDay = tod; this.weather = w;
    this._to = TIMES[TIME_KEY[tod]]; this._wTo = WEATHERS[WEATHER_KEY[w]];
    this._dur = Math.max(0.01, seconds); this._k = seconds <= 0 ? 1 : 0; this._timer = 0;
    if (this._k >= 1) this._apply(1);
  }

  /** @param {number} dt */
  update(dt) {
    if (this.cycleSeconds > 0 && this._k >= 1 && (this._cycleT += dt) >= this.cycleSeconds) {
      this._cycleT = 0;
      this.setTimeOfDay(CYCLE[(CYCLE.indexOf(this.timeOfDay) + 1) % CYCLE.length], Math.min(70, this.cycleSeconds * 0.5));
    }
    if (this.autoWeather && this._k >= 1 && (this._wTimer -= dt) <= 0) {
      this._wTimer = 150 + Math.random() * 150;
      const next = nextWeather(this.weather, Math.random());
      if (next !== this.weather) this.setWeather(next, 45);
    }
    if (this._k >= 1) return;
    this._k = Math.min(1, this._k + dt / this._dur);
    if ((this._timer -= dt) <= 0 || this._k >= 1) { this._timer = 0.25; this._apply(this._k); }
  }

  _apply(k) {
    const atmo = this.game.atmosphere;
    const s = k * k * (3 - 2 * k);
    const T = k >= 1 ? this._to : blendTime(this._from, this._to, s);
    const W = k >= 1 ? this._wTo : blendWeather(this._wFrom, this._wTo, s);
    if (k >= 1) { atmo.time = TIME_KEY[this.timeOfDay]; atmo.weather = WEATHER_KEY[this.weather]; }
    atmo.quiet = k < 1;
    atmo.applyPresets(T, W);
    atmo.quiet = false;
    this._refresh();
  }

  /** Derived values (lighting factor, sight ranges) from what the atmosphere currently shows. */
  _refresh() {
    const atmo = this.game.atmosphere;
    const T = atmo.T || TIMES[atmo.time], W = atmo.W || WEATHERS[atmo.weather];
    const night = T.dark;
    this.ambientLightFactor = clamp((1 - night * 0.85) * (0.55 + 0.45 * W.sunMul) , 0.05, 1);
    this.visibilityRangeMeters = BASE_VISIBILITY * clamp((1 - night * 0.62) * W.sight, 0.15, 1);
    this.thermalRangeMeters = BASE_VISIBILITY * clamp(0.55 + W.sight * 0.45, 0.5, 1);
    // Target acquisition speed for the naked eye (perception multiplies its detection rate by this).
    this.acquisitionFactor = atmo.vis;
    // Night combat reads: brighter tracers when it is dark.
    const p = this.game.particles;
    if (p && p.tracerMesh) p.tracerMesh.material.color.setRGB(5 + atmo.dark * 5, 3.4 + atmo.dark * 3, 1.4 + atmo.dark * 1.2);
  }
}
