import { MsgState, RADIO_TYPE_COUNT, RadioType } from './types.ts';

/**
 * A pooled radio message. Requests (CAS, fire missions, logistics, extraction)
 * are tickets: a provider claims an OPEN message, executes it and completes it.
 */
export class RadioMessage {
  id = 0;
  type = 0;
  team = 0;
  state: number = MsgState.FREE;
  senderId = -1;
  senderSquad = -1;
  /** Target / rendezvous point. */
  x = 0; y = 0; z = 0;
  /** Attack / ingress vector (CAS) or threat heading (AIR_THREAT). */
  vx = 0; vz = 0;
  radius = 0;
  /** Target index (soldiers then vehicles), or -1 for a grid mark. */
  targetIdx = -1;
  /** Laser-designated (spotter / LT): tighter fire missions and CAS runs. */
  lased = false;
  priority = 0;
  /** Logistics subtype (Logistics.*). */
  subtype = 0;
  time = 0;
  expires = 0;
  claimedBy = -1;
  claimTime = 0;
  /** First time any provider accepted it (0 = never); keep-alives are capped from here. */
  firstClaim = 0;
  /** Last keep-alive from the provider working on it. */
  aliveT = 0;
  /** Provider progress shown to the requester ("gunship en route", "turning to bear"...). */
  status = '';
  /** How it ended (requester feedback and statistics). */
  outcome = '';
  /** Times a provider had to hand it back (danger close, damage...). */
  handbacks = 0;
}

export interface RadioListener { onRadio(msg: RadioMessage): void }

/** Global per-team cooldown and per-sender cooldown (s) by message type. */
const TEAM_COOLDOWN = new Float32Array([0.5, 6, 5, 2, 1.5, 8, 0, 1, 0]);
const SENDER_COOLDOWN = new Float32Array([3, 20, 15, 12, 6, 30, 0, 6, 0]);
const LIFETIME = new Float32Array([6, 45, 30, 40, 8, 60, 20, 10, 45]);
/** Requests of the same type closer than this refresh the existing ticket. */
const DEDUPE_RADIUS = 40;
const DANGER_ZONES = 16;

/**
 * Typed, cooldown-gated tactical radio. Event-driven fan-out to listeners
 * registered once at start-up, claimable request tickets, and danger-close
 * zones for deconflicting friendly indirect fire and air strikes.
 */
export class TacticalRadioBus {
  readonly messages: RadioMessage[];
  private readonly listeners: RadioListener[][] = [];
  private readonly teamCooldown = new Float32Array(2 * RADIO_TYPE_COUNT);
  private readonly senderCooldown: Float32Array;
  private nextId = 1;
  readonly dangerX = new Float32Array(DANGER_ZONES);
  readonly dangerZ = new Float32Array(DANGER_ZONES);
  readonly dangerR = new Float32Array(DANGER_ZONES);
  readonly dangerUntil = new Float32Array(DANGER_ZONES);
  readonly dangerTeam = new Int8Array(DANGER_ZONES);
  readonly stats = { published: 0, suppressed: 0, claimed: 0, completed: 0 };
  /** Per message type: published, claimed, completed, expired never answered, expired after a claim, total seconds to claim. */
  readonly byType = Array.from({ length: RADIO_TYPE_COUNT }, () => ({ pub: 0, claimed: 0, done: 0, unanswered: 0, lapsed: 0, claimWait: 0, rejected: 0, handedBack: 0, calledOff: 0, outcomes: {} as Record<string, number> }));
  /** Why the last publish() returned null ('' = it did not). */
  lastRefusal = '';
  /** Crewed providers per team and request type (set by the vehicle orchestrator); 0 = nobody can answer. */
  readonly capacity = new Int16Array(2 * RADIO_TYPE_COUNT);
  capacityKnown = false;

  constructor(capacity: number, maxSenders: number) {
    this.messages = [];
    for (let i = 0; i < capacity; i++) this.messages.push(new RadioMessage());
    for (let t = 0; t < RADIO_TYPE_COUNT; t++) this.listeners.push([]);
    this.senderCooldown = new Float32Array(maxSenders * RADIO_TYPE_COUNT);
  }

  /** Registers a listener for a message type (start-up only). */
  subscribe(type: RadioType, listener: RadioListener): void { this.listeners[type].push(listener); }

  /**
   * Publishes a message unless cooldowns forbid it. A request near an open
   * request of the same type refreshes that ticket instead of duplicating it.
   * @returns the message (new or refreshed), or null when suppressed
   */
  publish(type: RadioType, team: number, senderId: number, senderSquad: number, x: number, y: number, z: number,
    targetIdx: number, priority: number, time: number, subtype = 0, lased = false): RadioMessage | null {
    const tk = team * RADIO_TYPE_COUNT + type;
    if (senderId >= 0) {
      const sk = senderId * RADIO_TYPE_COUNT + type;
      if (sk < this.senderCooldown.length && this.senderCooldown[sk] > time) { this.stats.suppressed++; return null; }
    }
    // Refresh an equivalent open ticket.
    for (let i = 0; i < this.messages.length; i++) {
      const m = this.messages[i];
      if (m.state === MsgState.FREE || m.state === MsgState.DONE || m.type !== type || m.team !== team || m.subtype !== subtype) continue;
      const dx = m.x - x, dz = m.z - z;
      if (dx * dx + dz * dz > DEDUPE_RADIUS * DEDUPE_RADIUS) continue;
      m.x = x; m.y = y; m.z = z;
      if (targetIdx >= 0) m.targetIdx = targetIdx;
      m.lased = m.lased || lased;
      if (priority > m.priority) m.priority = priority;
      m.expires = time + LIFETIME[type];
      this.markSender(senderId, type, time);
      return m;
    }
    this.lastRefusal = '';
    if (this.teamCooldown[tk] > time) { this.stats.suppressed++; this.lastRefusal = 'radio net busy (side cooldown)'; return null; }
    // Support requests that no asset of the side could answer are turned down at once (the requester sees null).
    const support = type === RadioType.FIRE_MISSION || type === RadioType.CAS_REQUEST || type === RadioType.LOGISTICS_REQUEST || type === RadioType.EXTRACT_REQUEST;
    if (support && this.capacityKnown && team >= 0 && team < 2 && this.capacity[team * RADIO_TYPE_COUNT + type] === 0) { this.byType[type].rejected++; this.lastRefusal = 'no crewed asset on our side can answer'; return null; }
    const m = this.alloc(time);
    m.id = this.nextId++;
    m.type = type; m.team = team; m.state = MsgState.OPEN;
    m.senderId = senderId; m.senderSquad = senderSquad;
    m.x = x; m.y = y; m.z = z; m.vx = 0; m.vz = 0; m.radius = 0;
    m.targetIdx = targetIdx; m.priority = priority; m.subtype = subtype; m.lased = lased;
    m.time = time; m.expires = time + LIFETIME[type]; m.claimedBy = -1; m.claimTime = 0;
    m.firstClaim = 0; m.aliveT = 0; m.status = ''; m.outcome = ''; m.handbacks = 0;
    this.teamCooldown[tk] = time + TEAM_COOLDOWN[type];
    this.markSender(senderId, type, time);
    this.stats.published++;
    this.byType[type].pub++;
    const ls = this.listeners[type];
    for (let i = 0; i < ls.length; i++) ls[i].onRadio(m);
    return m;
  }

  private markSender(senderId: number, type: number, time: number): void {
    if (senderId < 0) return;
    const sk = senderId * RADIO_TYPE_COUNT + type;
    if (sk < this.senderCooldown.length) this.senderCooldown[sk] = time + SENDER_COOLDOWN[type];
  }

  private alloc(time: number): RadioMessage {
    let oldest = this.messages[0];
    for (let i = 0; i < this.messages.length; i++) {
      const m = this.messages[i];
      if (m.state === MsgState.FREE || m.state === MsgState.DONE || m.expires < time) return m;
      if (m.priority < oldest.priority || (m.priority === oldest.priority && m.time < oldest.time)) oldest = m;
    }
    return oldest;
  }

  /**
   * Claims the best open ticket of a type for a provider: highest priority,
   * then nearest, within `maxRange` of (x, z).
   */
  claim(type: RadioType, team: number, claimerId: number, x: number, z: number, maxRange: number, time: number, minRange = 0): RadioMessage | null {
    let best: RadioMessage | null = null, bestScore = -1e9;
    const r2 = maxRange * maxRange, m2 = minRange * minRange;
    for (let i = 0; i < this.messages.length; i++) {
      const m = this.messages[i];
      if (m.state !== MsgState.OPEN || m.type !== type || m.team !== team || m.expires < time) continue;
      const dx = m.x - x, dz = m.z - z, d2 = dx * dx + dz * dz;
      if (d2 > r2 || d2 < m2) continue;
      const score = m.priority * 1000 - Math.sqrt(d2);
      if (score > bestScore) { bestScore = score; best = m; }
    }
    if (best) {
      if (best.claimTime === 0) { this.byType[type].claimed++; this.byType[type].claimWait += time - best.time; best.firstClaim = time; }
      best.state = MsgState.CLAIMED; best.claimedBy = claimerId; best.claimTime = time; best.aliveT = time; this.stats.claimed++;
    }
    return best;
  }

  /** True while a provider's claim on `m` is still the live ticket. */
  holds(m: RadioMessage | null, claimerId: number, id: number): boolean {
    return m !== null && m.id === id && m.state === MsgState.CLAIMED && m.claimedBy === claimerId;
  }

  complete(m: RadioMessage, outcome = 'done'): void {
    if (m.state !== MsgState.DONE) { this.byType[m.type].done++; this.tally(m.type, outcome); }
    m.state = MsgState.DONE; m.outcome = outcome; m.status = outcome; this.stats.completed++;
  }

  /** Hands a ticket back for another provider (e.g. provider damaged or destroyed, run aborted). */
  release(m: RadioMessage, why = ''): void {
    if (m.state !== MsgState.CLAIMED) return;
    m.state = MsgState.OPEN; m.claimedBy = -1;
    if (why) { m.status = `handed back: ${why}`; m.handbacks++; this.byType[m.type].handedBack++; }
  }

  /**
   * The request cannot be carried out by anyone (e.g. friendlies at the target): it ends now, with the reason,
   * instead of being claimed and dropped again until it times out.
   */
  callOff(m: RadioMessage, why: string, time: number): void {
    if (m.state === MsgState.FREE || m.state === MsgState.DONE) return;
    m.outcome = `called off: ${why}`; m.status = m.outcome; m.expires = time; m.state = MsgState.DONE;
    this.byType[m.type].calledOff++; this.tally(m.type, m.outcome);
  }

  /**
   * Provider keep-alive while it is visibly working on a ticket (en route, setting up, firing): the ticket
   * does not lapse under it, but only up to `cap` seconds after it was first accepted (no indefinite holds).
   */
  extend(m: RadioMessage, time: number, cap: number, status = ''): boolean {
    if (m.state !== MsgState.CLAIMED) return false;
    if (status) m.status = status;
    if (time - m.firstClaim > cap) return false;
    m.aliveT = time;
    m.expires = Math.max(m.expires, time + 12);
    return true;
  }

  private tally(type: number, outcome: string): void {
    const o = this.byType[type].outcomes;
    const k = outcome.replace(/[0-9]+/g, '#');
    o[k] = (o[k] || 0) + 1;
  }

  /** Expires stale tickets and reopens abandoned claims. */
  update(time: number): void {
    for (let i = 0; i < this.messages.length; i++) {
      const m = this.messages[i];
      if (m.state === MsgState.FREE || m.state === MsgState.DONE) continue;
      if (m.expires < time) {
        if (m.claimTime === 0) { this.byType[m.type].unanswered++; m.outcome = 'unanswered: no provider took it in time'; }
        else { this.byType[m.type].lapsed++; m.outcome = m.state === MsgState.CLAIMED ? `lapsed while ${m.status || 'accepted'}` : `lapsed after hand-back (${m.status || 'no reason'})`; }
        this.tally(m.type, m.outcome);
        m.state = MsgState.FREE; continue;
      }
      if (m.state === MsgState.CLAIMED && time - Math.max(m.claimTime, m.aliveT) > 50) { m.state = MsgState.OPEN; m.claimedBy = -1; m.status = 'handed back: provider went silent'; }
    }
  }

  openCount(type: RadioType, team: number): number {
    let n = 0;
    for (let i = 0; i < this.messages.length; i++) {
      const m = this.messages[i];
      if ((m.state === MsgState.OPEN || m.state === MsgState.CLAIMED) && m.type === type && m.team === team) n++;
    }
    return n;
  }

  // --- Danger-close deconfliction -------------------------------------------------

  /** Marks friendly ordnance about to land; ground units of `team` hold outside it. */
  addDangerZone(team: number, x: number, z: number, radius: number, until: number, time: number): void {
    let slot = 0, oldest = 1e9;
    for (let i = 0; i < DANGER_ZONES; i++) {
      if (this.dangerUntil[i] < time) { slot = i; break; }
      if (this.dangerUntil[i] < oldest) { oldest = this.dangerUntil[i]; slot = i; }
    }
    this.dangerX[slot] = x; this.dangerZ[slot] = z; this.dangerR[slot] = radius; this.dangerUntil[slot] = until; this.dangerTeam[slot] = team;
    this.publish(RadioType.DANGER_CLOSE, team, -1, -1, x, 0, z, -1, 3, time);
  }

  /** Index of the friendly danger zone containing (x, z) (+margin), or -1. */
  inDangerZone(team: number, x: number, z: number, margin: number, time: number): number {
    for (let i = 0; i < DANGER_ZONES; i++) {
      if (this.dangerUntil[i] < time || this.dangerTeam[i] !== team) continue;
      const dx = x - this.dangerX[i], dz = z - this.dangerZ[i], r = this.dangerR[i] + margin;
      if (dx * dx + dz * dz < r * r) return i;
    }
    return -1;
  }

  reset(): void {
    for (let i = 0; i < this.messages.length; i++) this.messages[i].state = MsgState.FREE;
    this.teamCooldown.fill(0); this.senderCooldown.fill(0); this.dangerUntil.fill(0);
  }
}
