/**
 * game/traps.ts - SPIKE trap contact damage (round 11, GDD 8 defenses).
 *
 * A SPIKE cell (materials id 19) is solid, standable timber: a 1-cell stake
 * row is stepped ONTO (STEP_UP_MAX=2), not blocked by - which is the trap. A
 * ZOMBIE whose feet overlap or rest on stakes rolls SPIKE_LEG_CHANCE per tick
 * to have an intact LEG torn off through THE GATE (applyDamage - real cells
 * released into the sim, the zombie drops to a crawl; a second unlucky roll
 * takes the other leg: "they may lose a leg or two"). Spikes ONLY take legs -
 * a legless crawler dragging itself across the stakes is never finished off
 * by them, and survivors pick their way between their own stakes (main only
 * calls this for zombies).
 *
 * Placement is the ordinary costed Build path ('spike' in building.ts): drop
 * a strip on open ground as a crawl-maker, or line a dug pit's floor to make
 * a deadfall (a zombie that tumbles in lands ON the stakes and keeps rolling
 * contact ticks while it scrabbles).
 *
 * The RNG lives in the body/AI layer (like combat.biteAttack), NEVER inside
 * simulation.step(), so chunk byte-equivalence is untouched. `rand` is
 * injectable for deterministic headless tests.
 */

import type { Body, BoneName } from '../characters/body';
import { applyDamage } from '../characters/damage';
import { get } from '../engine/grid';
import { SPIKE } from '../engine/materials';
import { registerHit } from './ui';
import { SPIKE_LEG_CHANCE, BODY_W } from '../config';

/**
 * Is this body in CONTACT with spikes? True when any cell across the body's
 * foot width, on the feet row or the row directly below it (standing ON
 * stakes), holds SPIKE. Pure grid read - no mutation.
 */
export function touchingSpikes(body: Body): boolean {
  const rx = Math.round(body.x);
  const ry = Math.round(body.y);
  const half = Math.floor(BODY_W / 2);
  for (let dx = -half; dx <= half; dx++) {
    if (get(rx + dx, ry) === SPIKE || get(rx + dx, ry + 1) === SPIKE) {
      return true;
    }
  }
  return false;
}

/**
 * One contact tick for one body (call per ALIVE ZOMBIE from main, after its
 * update): if it touches spikes, roll SPIKE_LEG_CHANCE to destroy an intact
 * leg via THE GATE. No-op for a body with no intact legs left (spikes never
 * escalate past legs). Returns the bone taken, or null.
 */
export function updateSpikeContact(
  body: Body,
  rand: () => number = Math.random,
): BoneName | null {
  if (!body.alive) return null;
  if (!touchingSpikes(body)) return null;
  if (rand() >= SPIKE_LEG_CHANCE) return null;
  const leg: BoneName | null = !body.lLegLost
    ? 'lLeg'
    : !body.rLegLost
      ? 'rLeg'
      : null;
  if (!leg) return null;
  applyDamage(body, leg);
  // Brief hit-flash so the maiming reads on screen (GDD 12).
  registerHit(body.x, body.y);
  return leg;
}
