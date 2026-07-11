/**
 * game/children.ts - colony growth: HUTS raise CHILDREN (round 11, GDD 6.1).
 *
 * "When there is a hut, and more than one survivor, it should create children
 * over time - they should be smaller sprites but quickly grow into normal
 * survivors."
 *
 * Rules:
 *   - BIRTH: while at least one hut stands (game/prefabs.ts) and at least
 *     CHILD_MIN_ADULTS living, un-turned ADULTS exist, a birth countdown runs;
 *     at zero a CHILD survivor appears at the newest hut's hearth (interior
 *     anchor). Births pause at the population ceiling (CHILD_CAP_PER_HUT per
 *     hut, children included) and while the conditions lapse.
 *   - CHILD: a normal Survivor in every mechanical way (needs, wander, flee,
 *     warmth, THE GATE damage) but with the half-scale childRig body and
 *     child:true - assignRole refuses working roles until it grows up.
 *   - GROWTH: growTicks counts down each tick; at zero the rig is swapped for
 *     the full adult figure IN PLACE (same feet anchor, limb-loss flags reset
 *     with the fresh rig) and the survivor becomes assignable.
 *
 * All of this runs in the BODY/AI layer from main's tick (like waves.ts -
 * updateChildren RETURNS newborns for main to push onto the live array); no
 * RNG, no DOM, and nothing here ever touches simulation.step(), so chunk
 * byte-equivalence is untouched. Module state is one countdown + reset(),
 * mirroring resources.ts / prefabs.ts.
 */

import type { Survivor } from '../characters/survivor';
import { createSurvivor } from '../characters/survivor';
import { childRig, adultRig } from '../characters/body';
import { getHuts, latestHut } from './prefabs';
import {
  CHILD_BIRTH_TICKS,
  CHILD_MIN_ADULTS,
  CHILD_GROW_TICKS,
  CHILD_CAP_PER_HUT,
} from '../config';

// Ticks remaining until the next birth while conditions hold.
let birthCountdown = CHILD_BIRTH_TICKS;

/** Reset the birth clock (new-game init / test harness). */
export function resetChildren(): void {
  birthCountdown = CHILD_BIRTH_TICKS;
}

/** Living, un-turned survivors (children included) - the population count. */
function livingCount(survivors: Survivor[]): number {
  let n = 0;
  for (const s of survivors) if (s.body.alive && !s.turned) n++;
  return n;
}

/** Living, un-turned, fully-grown adults - the parents count. */
function adultCount(survivors: Survivor[]): number {
  let n = 0;
  for (const s of survivors) if (s.body.alive && !s.turned && !s.child) n++;
  return n;
}

/**
 * Build one CHILD survivor at feet-centre (x, y): a regular createSurvivor
 * with the half-scale rig swapped in and the growth clock armed. Exported for
 * the headless suite.
 */
export function createChild(x: number, y: number): Survivor {
  const s = createSurvivor(x, y);
  s.body.rig = childRig();
  s.child = true;
  s.growTicks = CHILD_GROW_TICKS;
  return s;
}

/**
 * Swap a grown child's rig for the adult figure IN PLACE: same feet anchor,
 * fresh intact limbs (the capability flags reset with the new rig), the child
 * flag drops and the survivor becomes assignable. Exported for the suite.
 */
export function growUp(s: Survivor): void {
  s.body.rig = adultRig();
  s.body.lLegLost = false;
  s.body.rLegLost = false;
  s.body.lArmLost = false;
  s.body.rArmLost = false;
  s.body.reachLeft = true;
  s.body.reachRight = true;
  s.child = false;
  s.growTicks = 0;
}

/**
 * One tick of colony growth (call once per sim tick from main, after the
 * survivor updates):
 *   1. GROW: tick every living child's clock; at zero it grows up in place.
 *   2. BIRTH: while a hut stands, adults >= CHILD_MIN_ADULTS and the
 *      population is under the ceiling, run the countdown; at zero, one
 *      newborn is RETURNED (main pushes it onto the live array and re-homes
 *      it like any survivor). The countdown only runs while ALL conditions
 *      hold, so a colony that loses its huts/adults stops mid-count and
 *      resumes where it left off.
 */
export function updateChildren(survivors: Survivor[]): Survivor[] {
  // 1. Growth.
  for (const s of survivors) {
    if (!s.child || !s.body.alive || s.turned) continue;
    if (s.growTicks > 0) {
      s.growTicks--;
      if (s.growTicks === 0) growUp(s);
    }
  }

  // 2. Births.
  const huts = getHuts();
  if (huts.length === 0) return [];
  if (adultCount(survivors) < CHILD_MIN_ADULTS) return [];
  if (livingCount(survivors) >= CHILD_CAP_PER_HUT * huts.length) return [];

  birthCountdown--;
  if (birthCountdown > 0) return [];
  birthCountdown = CHILD_BIRTH_TICKS;

  const hut = latestHut();
  if (!hut) return [];
  const kid = createChild(hut.x, hut.y);
  kid.home.x = hut.x;
  kid.home.y = hut.y;
  return [kid];
}
