/**
 * characters/corpseLifecycle.ts — Pure corpse render-list builder + decay helper.
 *
 * Task 2, revised death model (GDD §5.1 "Quiet/needs → lie down as a corpse",
 * §13 "corpses capped/decay like gore").  These are PURE helpers: no DOM, no
 * canvas, no side-effect imports — safe for headless unit tests.
 *
 * Call order each sim tick (from main.ts simulationTick):
 *   1. tickCorpseDecay(bodies)          — decrement corpseTicks; retire at 0.
 *   2. buildCorpseRenderList(bodies)    — collect active corpses, apply cap.
 *   3. setCorpseBodies(result)          — hand the list to the renderer.
 */

import { MAX_CORPSES } from '../config';
import type { Body } from './body';

/**
 * Advance corpse decay for every body in `bodies`.
 *
 * For each body where `alive===false && corpse===true && corpseTicks>0`:
 *   - Decrement corpseTicks by 1.
 *   - When corpseTicks reaches 0, retire the corpse by setting `corpse=false`
 *     so it drops off the render list and is never drawn again.
 *
 * Called once per simulation tick, BEFORE buildCorpseRenderList.
 */
export function tickCorpseDecay(bodies: Body[]): void {
  for (const body of bodies) {
    if (!body.alive && body.corpse && body.corpseTicks > 0) {
      body.corpseTicks--;
      if (body.corpseTicks <= 0) {
        body.corpse = false; // retired — no longer drawn
      }
    }
  }
}

/**
 * Build the list of bodies that should be drawn as corpses this frame.
 *
 * A body qualifies if: `alive===false && corpse===true && corpseTicks>0`.
 *
 * If the qualifying count exceeds MAX_CORPSES (GDD §13 hard cap), the OLDEST
 * corpses (lowest corpseTicks — they have decayed the most) are retired first
 * by mutating `body.corpse = false`, keeping count ≤ MAX_CORPSES.  Retirement
 * is deterministic (stable sort on corpseTicks) so the result is reproducible.
 *
 * Returns the active corpse render list (always length ≤ MAX_CORPSES).
 */
export function buildCorpseRenderList(bodies: Body[]): Body[] {
  // Collect currently-active corpses.
  const active = bodies.filter((b) => !b.alive && b.corpse && b.corpseTicks > 0);

  // Apply the MAX_CORPSES cap: retire oldest (lowest corpseTicks) first.
  if (active.length > MAX_CORPSES) {
    // Sort ascending by corpseTicks — the entries with the lowest remaining
    // ticks are the oldest and are retired first (GDD §13 cap behaviour).
    active.sort((a, b) => a.corpseTicks - b.corpseTicks);
    const excess = active.splice(0, active.length - MAX_CORPSES);
    for (const b of excess) {
      b.corpse = false; // retired immediately
    }
  }

  return active;
}
