/**
 * characters/locomotion.ts — Rigged body locomotion (GDD §5.1 "fall").
 *
 * Cheap, reliable rigged-character motion (NOT soft-body — GDD §13): the whole
 * body translates in WHOLE world cells against the live cellular grid. This task
 * (p3-t2) implements the ground probe + gravity only:
 *
 *   - The body falls under BODY_GRAVITY when ungrounded, capped at BODY_FALL_MAX.
 *   - The fall is SWEPT one cell at a time and stops the instant the next step
 *     down would overlap solid terrain — so a fast-falling body can never tunnel
 *     through thin ground (this no-tunnel invariant is what THE GATE rides on).
 *   - The body rests with its lowest pixel exactly one cell above the floor.
 *
 * Horizontal walk + gentle-slope climbing (p3-t3) live here too; drowning/burial
 * (Phase 4) and AI (Phase 5) are out of scope. The horizontal step is SWEPT one
 * whole cell at a time against the live grid (same no-tunnel discipline as the
 * fall), with a single-cell step-up so the body climbs gentle slopes (GDD §5.1,
 * §7.1, §14 Milestone 0) but stops dead at anything taller than STEP_UP_MAX.
 * DOM-free pure logic so it stays headless-testable.
 */

import type { Body } from './body';
import { get } from '../engine/grid';
import { isSolidForBody } from '../engine/materials';
import { BODY_GRAVITY, BODY_FALL_MAX, WALK_SPEED, STEP_UP_MAX } from '../config';

/**
 * Would the body — if translated by (dxCells, dyCells) WHOLE cells — land ANY
 * of its non-destroyed pixels in a solid cell? Used for all collision tests.
 *
 * A pixel's world cell is the feet-centre anchor plus its bone offset and its
 * local offset (see body.ts), then shifted by the proposed translation.
 */
export function bodyCellsSolidAt(
  body: Body,
  dxCells: number,
  dyCells: number,
): boolean {
  const rx = Math.round(body.x) + dxCells;
  const ry = Math.round(body.y) + dyCells;
  for (const bone of body.rig) {
    if (bone.destroyed) continue;
    for (const p of bone.pixels) {
      const wx = rx + bone.offset.dx + p.dx;
      const wy = ry + bone.offset.dy + p.dy;
      if (isSolidForBody(get(wx, wy))) return true;
    }
  }
  return false;
}

/**
 * Attempt ONE whole-cell horizontal step in direction `step` (-1 or +1) from the
 * body's current integer column, resolving collisions (GDD §5.1, §7.1):
 *   - Clear ahead → take the step.
 *   - Blocked but a 1..STEP_UP_MAX rise clears (gentle slope) → step up onto it.
 *   - Blocked by a taller wall → don't move (caller stops at the wall).
 * Returns true iff the body moved. Never leaves a pixel overlapping solid.
 */
function tryHorizontalStep(body: Body, step: 1 | -1): boolean {
  // Clear path at the same height → just walk forward.
  if (!bodyCellsSolidAt(body, step, 0)) {
    body.x += step;
    return true;
  }
  // Blocked: try to mount a gentle rise. For each height, a CLEAR raised
  // position (no overlap) is both the slope test and the headroom test.
  for (let h = 1; h <= STEP_UP_MAX; h++) {
    if (!bodyCellsSolidAt(body, step, -h)) {
      body.x += step; // GDD §5.1: climb the gentle slope by one cell
      body.y -= h;
      return true;
    }
  }
  // Taller than STEP_UP_MAX → stop at the wall.
  return false;
}

/**
 * Advance one body by one sim tick: horizontal walk/step-up (p3-t3), THEN the
 * ground-probe + swept fall (p3-t2). Resolving horizontal motion first means
 * walking off a ledge re-evaluates support below and falls into pits.
 * Call once per sim tick.
 */
export function updateBody(body: Body): void {
  // --- Horizontal motion (p3-t3) -------------------------------------------
  // Driven by body.moveDir (set externally by t5's driver — no AI here).
  if (body.moveDir !== 0) {
    body.facing = body.moveDir; // always face the way we intend to move
    body.xRemainder += body.moveDir * WALK_SPEED;
    // Flush whole-cell crossings (rounded column changes when |frac| >= 0.5).
    // WALK_SPEED < 1 so this is at most one step/tick, but loop for safety.
    while (Math.abs(body.xRemainder) >= 0.5) {
      const step: 1 | -1 = body.xRemainder >= 0.5 ? 1 : -1;
      if (tryHorizontalStep(body, step)) {
        body.xRemainder -= step;
      } else {
        body.xRemainder = 0; // wall: drop progress so we rest flush against it
        break;
      }
    }
  }

  // --- Ground probe + swept fall (p3-t2) -----------------------------------
  // Ground probe: grounded iff a step down by 1 cell would overlap solid
  // (i.e. there is solid directly beneath a foot pixel — GDD §5.1).
  if (bodyCellsSolidAt(body, 0, 1)) {
    body.grounded = true;
    body.vy = 0;
    return;
  }

  // Ungrounded → accelerate downward, capped so we never accumulate enough
  // speed to skip past thin terrain in a single tick beyond what the swept
  // step loop below can resolve.
  body.grounded = false;
  body.vy = Math.min(body.vy + BODY_GRAVITY, BODY_FALL_MAX);

  // Swept fall: move down ONE cell at a time, stopping the instant the next
  // step would overlap solid. This is the no-tunnel guarantee.
  const steps = Math.floor(body.vy);
  for (let i = 0; i < steps; i++) {
    if (bodyCellsSolidAt(body, 0, 1)) break; // next step lands in solid → stop
    body.y += 1;
  }

  // Recompute grounded after the move so the body rests cleanly on the floor
  // (lowest foot pixel exactly one cell above the solid, no overlap).
  if (bodyCellsSolidAt(body, 0, 1)) {
    body.grounded = true;
    body.vy = 0;
  }
}
