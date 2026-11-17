import { AI_TUNING, Action } from './types.ts';

/**
 * Structure-of-arrays state for every soldier (indexed by soldier id), shared
 * by perception, utility, squads and the vehicle orchestrator. Allocated once.
 */
export class AgentStateBuffers {
  readonly n: number;
  readonly action: Uint8Array;
  readonly actionStart: Float32Array;
  readonly commitUntil: Float32Array;
  readonly actionScore: Float32Array;
  /** 0..1, rises with near misses / hits / nearby blasts, decays over time. */
  readonly suppression: Float32Array;
  /** 0..1, falls with casualties and suppression, recovers near the leader and in cover. */
  readonly morale: Float32Array;
  /** Decaying directional threat vector (where incoming fire comes from). */
  readonly threatX: Float32Array;
  readonly threatZ: Float32Array;
  readonly lastTactical: Float32Array;
  readonly lastPerception: Float32Array;
  readonly lod: Uint8Array;
  readonly fireteam: Uint8Array;
  readonly coverNode: Int32Array;
  readonly arrived: Uint8Array;
  readonly smokeReadyAt: Float32Array;
  readonly lastHitAt: Float32Array;
  readonly nextShareAt: Float32Array;
  readonly nextRadioAt: Float32Array;
  /** Seat ticket id held (-1 none). */
  readonly ticket: Int32Array;
  /** Vehicle id a support soldier is repairing / soldier id being healed. */
  readonly repairTarget: Int32Array;
  readonly healTarget: Int32Array;
  /** Formation slot within the squad. */
  readonly slot: Uint8Array;
  readonly rng: Uint32Array;

  constructor(n: number, seed: number) {
    this.n = n;
    this.action = new Uint8Array(n).fill(Action.PATROL);
    this.actionStart = new Float32Array(n);
    this.commitUntil = new Float32Array(n);
    this.actionScore = new Float32Array(n);
    this.suppression = new Float32Array(n);
    this.morale = new Float32Array(n).fill(1);
    this.threatX = new Float32Array(n);
    this.threatZ = new Float32Array(n);
    this.lastTactical = new Float32Array(n);
    this.lastPerception = new Float32Array(n);
    this.lod = new Uint8Array(n);
    this.fireteam = new Uint8Array(n);
    this.coverNode = new Int32Array(n).fill(-1);
    this.arrived = new Uint8Array(n);
    this.smokeReadyAt = new Float32Array(n);
    this.lastHitAt = new Float32Array(n).fill(-100);
    this.nextShareAt = new Float32Array(n);
    this.nextRadioAt = new Float32Array(n);
    this.ticket = new Int32Array(n).fill(-1);
    this.repairTarget = new Int32Array(n).fill(-1);
    this.healTarget = new Int32Array(n).fill(-1);
    this.slot = new Uint8Array(n);
    this.rng = new Uint32Array(n);
    for (let i = 0; i < n; i++) this.rng[i] = (seed * 2654435761 + i * 40503) >>> 0;
  }

  /** Clears transient state for a (re)spawned soldier. */
  resetSoldier(i: number, time: number): void {
    this.action[i] = Action.PATROL; this.actionStart[i] = time; this.commitUntil[i] = 0; this.actionScore[i] = 0;
    this.suppression[i] = 0; this.morale[i] = 1; this.threatX[i] = 0; this.threatZ[i] = 0;
    this.coverNode[i] = -1; this.arrived[i] = 0; this.lastHitAt[i] = -100; this.smokeReadyAt[i] = 0;
    this.repairTarget[i] = -1; this.healTarget[i] = -1;
    // Stagger perception/tactics deterministically by id.
    this.lastTactical[i] = time - ((i * 0.618034) % 1) / AI_TUNING.tacticalHz;
    this.lastPerception[i] = time - ((i * 0.381966) % 1) / AI_TUNING.perceptionHz;
  }
}
