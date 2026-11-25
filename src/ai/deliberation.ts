/**
 * Deliberation: the five questions every AI decision answers, and the fallback when one fails.
 *
 *   Q1 Why am I / are we doing this?            a grounded reason: an order, a threat we know of, a need we have
 *   Q2 Is it necessary?                         not redundant, not already covered, not breaking a commitment
 *   Q3 What do I / my teammates gain from it?   benefit against the risk it carries
 *   Q4 What does the outcome do for us?         a concrete result: ground, a kill, a ride, a safer squad
 *   Q5 Is everything it needs available now?    ammo, a seat, a free vehicle, enough troops, fuel, the time
 *   Q6 (fallback) Is there anything else we could do instead? → the next option goes through Q1–Q5 again.
 *
 * Every decision maker (soldier, squad, vehicle crew, theater commander) proposes its options with a utility,
 * then walks them best first: the first option whose five answers all hold is taken. When none holds, the caller
 * keeps what it is doing (its own default), which is itself an option it usually proposes.
 *
 * Organic thresholds. Answers are confidences in 0..1 (booleans count as 0 / 1) tested against a threshold
 * that depends on who is asking: a bold soldier accepts a riskier benefit (Q3) and a looser necessity (Q2) than a
 * cautious one, stress makes Q3 stricter, and a slow per-actor "mood" (a hash of actor and a ~20 s time bucket)
 * shifts it a little more, so two soldiers in the same spot do not decide in lockstep. Q1, Q4 and Q5 are
 * factual and use a fixed bar.
 *
 * Zero allocation per decision: options live in pre-sized typed arrays owned by each Deliberation.
 */

import { hash01 } from './types.ts';

export const Q = { PASS: 0, WHY: 1, NEED: 2, BENEFIT: 3, OUTCOME: 4, RESOURCES: 5 } as const;
export const Q_NAMES = ['pass', 'why', 'necessary', 'benefit', 'outcome', 'resources'];

/** Domains, for the statistics and the debug overlay. */
export const Domain = { SOLDIER: 0, SQUAD: 1, VEHICLE: 2, COMMANDER: 3 } as const;
export const DOMAIN_NAMES = ['soldier', 'squad', 'vehicle', 'commander'];

/** Per-domain counters: decisions, options checked, rejections by question, fallbacks (Q6) and dead ends. */
export const deliberationStats = {
  decisions: [0, 0, 0, 0],
  checked: [0, 0, 0, 0],
  rejected: [[0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0]],
  /** Chose an option other than the first one proposed (Q6 found another way). */
  fallback: [0, 0, 0, 0],
  /** Nothing passed: the actor kept its default. */
  none: [0, 0, 0, 0],
};

const MAX = 48;

export class Deliberation {
  private ids = new Int32Array(MAX);
  private util = new Float32Array(MAX);
  private tried = new Uint8Array(MAX);
  private n = 0;
  private steps = 0;
  private th = new Float32Array(6);
  /** Option ids and the question each rejected one failed on, for the debug trace of the last decision. */
  readonly lastFail = new Uint8Array(MAX);
  readonly lastIds = new Int32Array(MAX);
  lastN = 0;
  lastChosen = -1;
  /** The question that rejected the last checked option (0 when it passed). */
  lastQ = 0;

  readonly domain: number;
  constructor(domain: number) { this.domain = domain; }

  /**
   * Starts a decision.
   * @param actor  stable id of who decides (soldier index, squad id, vehicle id, team)
   * @param time   game time (for the slow mood term)
   * @param temper 0 cautious … 1 bold
   * @param stress 0 calm … 1 under heavy fire / losing badly
   */
  begin(actor: number, time: number, temper = 0.5, stress = 0): this {
    this.n = 0; this.steps = 0; this.lastChosen = -1; this.lastN = 0;
    const mood = (hash01(actor * 31 + this.domain, Math.floor(time / 20)) - 0.5) * 0.12;
    const t = this.th;
    t[1] = 0.5; t[4] = 0.5; t[5] = 0.5;
    t[2] = 0.5 - (temper - 0.5) * 0.2 + mood * 0.5;
    t[3] = 0.5 - (temper - 0.5) * 0.3 + stress * 0.15 + mood;
    deliberationStats.decisions[this.domain]++;
    return this;
  }

  /** Proposes an option (ids are the caller's own codes). */
  propose(id: number, utility: number): void {
    if (this.n >= MAX || !(utility > -1e8)) return;
    this.ids[this.n] = id; this.util[this.n] = utility; this.tried[this.n] = 0; this.n++;
  }

  /** Q6: the best option not yet tried, or -1 when there is nothing else to do. */
  next(): number {
    let bi = -1, bu = -1e9;
    for (let i = 0; i < this.n; i++) if (!this.tried[i] && this.util[i] > bu) { bu = this.util[i]; bi = i; }
    if (bi < 0) return -1;
    this.tried[bi] = 1;
    this.steps++;
    this.lastIds[this.lastN] = this.ids[bi];
    return this.ids[bi];
  }

  /**
   * Answers Q1–Q5 for the option last returned by next(). Each answer is a confidence (0..1) or a boolean.
   * @returns 0 when it holds, else the question (1–5) that failed.
   */
  check(why: number | boolean, need: number | boolean, benefit: number | boolean, outcome: number | boolean, resources: number | boolean): number {
    const d = this.domain, t = this.th;
    deliberationStats.checked[d]++;
    let q = 0;
    if (+why < t[1]) q = 1;
    else if (+need < t[2]) q = 2;
    else if (+benefit < t[3]) q = 3;
    else if (+outcome < t[4]) q = 4;
    else if (+resources < t[5]) q = 5;
    this.lastQ = q;
    if (this.lastN < MAX) this.lastFail[this.lastN++] = q;
    if (q) deliberationStats.rejected[d][q]++;
    return q;
  }

  /** Marks the option last returned by next() as the decision. */
  choose(id: number): number {
    this.lastChosen = id;
    if (this.steps > 1) deliberationStats.fallback[this.domain]++;
    return id;
  }

  /** Nothing passed: the caller keeps its default. */
  none(): number {
    deliberationStats.none[this.domain]++;
    return -1;
  }

  /** Human-readable trace of the last decision ("ENGAGE✗benefit → COVER✓"). */
  trace(names: readonly string[]): string {
    let s = '';
    for (let i = 0; i < this.lastN; i++) {
      const id = this.lastIds[i], q = this.lastFail[i];
      s += (i ? ' → ' : '') + (names[id] ?? String(id)) + (q ? `✗${Q_NAMES[q]}` : '✓');
    }
    return s || '—';
  }
}

/** Summary line per domain for reports and the debug overlay. */
export function deliberationSummary(): string {
  const S = deliberationStats;
  let out = '';
  for (let d = 0; d < 4; d++) {
    if (!S.decisions[d]) continue;
    const r = S.rejected[d];
    out += `${DOMAIN_NAMES[d]}: ${S.decisions[d]} decisions, ${S.checked[d]} options checked, rejected Q1 ${r[1]} Q2 ${r[2]} Q3 ${r[3]} Q4 ${r[4]} Q5 ${r[5]}, Q6 fallback ${S.fallback[d]}, kept default ${S.none[d]}\n`;
  }
  return out;
}

export function resetDeliberationStats(): void {
  const S = deliberationStats;
  for (let d = 0; d < 4; d++) { S.decisions[d] = 0; S.checked[d] = 0; S.fallback[d] = 0; S.none[d] = 0; S.rejected[d].fill(0); }
}
