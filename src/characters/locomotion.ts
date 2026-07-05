/**
 * characters/locomotion.ts - Rigged body locomotion (GDD 5.1 "fall").
 *
 * Cheap, reliable rigged-character motion (NOT soft-body - GDD 13): the whole
 * body translates in WHOLE world cells against the live cellular grid. This task
 * (p3-t2) implements the ground probe + gravity only:
 *
 *   - The body falls under BODY_GRAVITY when ungrounded, capped at BODY_FALL_MAX.
 *   - The fall is SWEPT one cell at a time and stops the instant the next step
 *     down would overlap solid terrain - so a fast-falling body can never tunnel
 *     through thin ground (this no-tunnel invariant is what THE GATE rides on).
 *   - The body rests with its lowest pixel exactly one cell above the floor.
 *
 * Horizontal walk + gentle-slope climbing (p3-t3) live here too. Phase 4 (p4-t4,
 * THE GATE) adds the degraded gait: a body that has lost a leg crawls at
 * CRAWL_SPEED (GDD 7.2), and a DEAD body is never driven here - its released
 * cells are owned by the cellular sim. AI (Phase 5) is still out of scope. The horizontal step is SWEPT one
 * whole cell at a time against the live grid (same no-tunnel discipline as the
 * fall), with a single-cell step-up so the body climbs gentle slopes (GDD 5.1,
 * 7.1, 14 Milestone 0) but stops dead at anything taller than STEP_UP_MAX.
 * DOM-free pure logic so it stays headless-testable.
 */

import type { Body, Bone } from './body';
import { layDownCorpse, applyDamage } from './damage';
import { get } from '../engine/grid';
import { isSolidForBody, isFluid, WATER, FIRE } from '../engine/materials';
import {
  BODY_GRAVITY,
  BODY_FALL_MAX,
  WALK_SPEED,
  CRAWL_SPEED,
  STEP_UP_MAX,
  DROWN_TICKS,
  BURIAL_PIN,
  BODY_BURN_DAMAGE_CHANCE,
} from '../config';

/**
 * Read the world at the head bone's cells and resolve the two environmental
 * reactions THE GATE owns at gate point 4 (GDD 5.2 / 7.3 - the rigged body
 * "reads the world: sand above, water over head, and reacts"):
 *
 *   - DROWN: if ANY head cell is WATER the body holds its breath (drownTicks++);
 *     the instant the head clears the surface the counter resets. When it
 *     reaches DROWN_TICKS the body drowns -> lays down as a prone CORPSE (revised
 *     death model, GDD 5.1: drowning is a QUIET death, not the cell-dissolve)
 *     and we report it so the caller bails.
 *   - PIN: if solid NON-fluid terrain (sand/dirt/stone) sits directly on top of
 *     the head, the body is buried/pinned - its horizontal walk is suppressed
 *     this tick (falling/settling still resolves below).
 *
 * Cheap: one short scan of the head bone's authored pixels (<=6 cells), no grid
 * sweep. Returns whether the body is (a) now dead and (b) pinned this tick.
 */
function reactToEnvironment(body: Body): { dead: boolean; pinned: boolean } {
  const head = body.rig.find((b) => b.name === 'head');
  // A destroyed/absent head means the body is already dead or dissolving - the
  // dead-body guard upstream handles it, so there is nothing to read here.
  if (!head || head.destroyed) {
    return { dead: false, pinned: false };
  }

  const rx = Math.round(body.x);
  const ry = Math.round(body.y);

  // Single pass over the head cells: detect submersion AND find the top row.
  let headInWater = false;
  let topDy = Infinity;
  for (const p of head.pixels) {
    const wx = rx + head.offset.dx + p.dx;
    const wy = ry + head.offset.dy + p.dy;
    if (get(wx, wy) === WATER) headInWater = true;
    if (p.dy < topDy) topDy = p.dy;
  }

  // --- Drown (GDD 5.2 "head submerged too long" / 7.3 drowned) -----------
  // Only bodies that BREATHE drown (playtest v0.9 Q): the undead walk the lake
  // bottom with the clock never running. Buoyant bodies normally surface long
  // before DROWN_TICKS - the clock still matters when they are TRAPPED under a
  // solid ceiling (locomotion cannot rise them), so drowning stays meaningful.
  if (headInWater && body.breathes) {
    body.drownTicks++;
    if (body.drownTicks >= DROWN_TICKS) {
      // GDD 5.1: drowning is a QUIET death - the rig lies down as a prone
      // corpse (inert, decays over time), NOT the extreme cell-dissolve.
      layDownCorpse(body, 'drowned');
      return { dead: true, pinned: false };
    }
  } else {
    body.drownTicks = 0; // surfaced -> breath recovers (MVP: instant reset)
  }

  // --- Buried / pinned (GDD 7.3 "buried by collapsing sand") --------------
  // Pinned iff the cell directly ABOVE any top-row head pixel is solid, non-
  // fluid terrain (sand/dirt/stone/etc). Fluids over the head drown, they don't
  // pin; foliage/AIR don't pin. Only the head's top row matters - cheap.
  let pinned = false;
  if (BURIAL_PIN) {
    const aboveY = ry + head.offset.dy + topDy - 1;
    for (const p of head.pixels) {
      if (p.dy !== topDy) continue;
      const m = get(rx + head.offset.dx + p.dx, aboveY);
      if (isSolidForBody(m) && !isFluid(m)) {
        pinned = true;
        break;
      }
    }
  }

  return { dead: false, pinned };
}

/**
 * Does ANY of this bone's world cells sit orthogonally adjacent to a FIRE cell?
 * (GDD 7.3: "flesh is flammable ... it spreads body-to-body".) Cheap 4-neighbour
 * probe per authored pixel - the same fire that ignites loose terrain is what
 * catches the live figure, so the contact rule stays identical to the sim's.
 */
function boneTouchesFire(body: Body, bone: Bone, rx: number, ry: number): boolean {
  for (const p of bone.pixels) {
    const wx = rx + bone.offset.dx + p.dx;
    const wy = ry + bone.offset.dy + p.dy;
    if (
      get(wx + 1, wy) === FIRE ||
      get(wx - 1, wy) === FIRE ||
      get(wx, wy + 1) === FIRE ||
      get(wx, wy - 1) === FIRE
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Fire ignition hook (p4-t6, THE GATE gate point 3, GDD 7.3). A LIVING body
 * whose flesh touches FIRE catches and starts shedding burning flesh: for each
 * non-destroyed bone adjacent to fire, with probability BODY_BURN_DAMAGE_CHANCE
 * we applyDamage(bone) - the bone's pixels are RELEASED into the live sim where
 * the same adjacent fire ignites them via the normal Phase-2 spread (FLESH is
 * flammable), so the seam between sprite and shed cells stays invisible. A
 * sustained head/torso catch cascades to death via the existing dissolve
 * thresholds (applyDamage -> dissolveBody).
 *
 * Tiny and gated: living bodies only, only on real fire adjacency, low chance,
 * NO per-pixel fire-on-sprite system. We iterate a SNAPSHOT of the rig because
 * applyDamage mutates it (releasing bones, possibly dissolving the whole body),
 * and bail the instant a catch killed us. applyDamage already no-ops a destroyed
 * bone, so there is no double-apply.
 */
function checkFire(body: Body): void {
  const rx = Math.round(body.x);
  const ry = Math.round(body.y);
  const bones = body.rig.slice(); // snapshot - applyDamage mutates the rig
  for (const bone of bones) {
    if (!body.alive) {
      return; // a head/torso catch dissolved the body - stop scanning
    }
    if (bone.destroyed) {
      continue;
    }
    if (!boneTouchesFire(body, bone, rx, ry)) {
      continue;
    }
    if (Math.random() < BODY_BURN_DAMAGE_CHANCE) {
      applyDamage(body, bone.name); // release the bone; its flesh ignites in-sim
    }
  }
}

/**
 * Is ANY cell of the named bone WATER right now? Bounded probe over the bone's
 * authored pixels (<=20 cells), mirroring reactToEnvironment's head scan. Used
 * by the buoyancy resolve (playtest v0.9 Q): the HEAD probe decides "fully
 * submerged -> rise", the TORSO probe decides "at the float line -> the water
 * supports the body". A destroyed/absent bone reads false (a mangled body
 * sinks - acceptable degradation).
 */
function boneInWater(body: Body, name: string): boolean {
  const bone = body.rig.find((b) => b.name === name);
  if (!bone || bone.destroyed) return false;
  const rx = Math.round(body.x);
  const ry = Math.round(body.y);
  for (const p of bone.pixels) {
    if (get(rx + bone.offset.dx + p.dx, ry + bone.offset.dy + p.dy) === WATER) {
      return true;
    }
  }
  return false;
}

/**
 * Would the body - if translated by (dxCells, dyCells) WHOLE cells - land ANY
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
 * body's current integer column, resolving collisions (GDD 5.1, 7.1):
 *   - Clear ahead -> take the step.
 *   - Blocked but a 1..STEP_UP_MAX rise clears (gentle slope) -> step up onto it.
 *   - Blocked by a taller wall -> don't move (caller stops at the wall).
 * Returns true iff the body moved. Never leaves a pixel overlapping solid.
 */
function tryHorizontalStep(body: Body, step: 1 | -1): boolean {
  // Clear path at the same height -> just walk forward.
  if (!bodyCellsSolidAt(body, step, 0)) {
    body.x += step;
    return true;
  }
  // Blocked: try to mount a gentle rise. For each height, a CLEAR raised
  // position (no overlap) is both the slope test and the headroom test.
  for (let h = 1; h <= STEP_UP_MAX; h++) {
    if (!bodyCellsSolidAt(body, step, -h)) {
      body.x += step; // GDD 5.1: climb the gentle slope by one cell
      body.y -= h;
      return true;
    }
  }
  // Taller than STEP_UP_MAX -> stop at the wall.
  return false;
}

/**
 * Advance one body by one sim tick: horizontal walk/step-up (p3-t3), THEN the
 * ground-probe + swept fall (p3-t2). Resolving horizontal motion first means
 * walking off a ledge re-evaluates support below and falls into pits.
 * Call once per sim tick.
 */
export function updateBody(body: Body): void {
  // --- Dead-body guard (p4-t4, THE GATE) -----------------------------------
  // GDD 7.2: a dead body's pixels have been released into the live sim (the
  // death-collapse) - its cells are driven by the cellular update, NOT by the
  // rig. Never drive locomotion on a corpse (and don't crash if main.ts hands
  // us one): bail before touching horizontal motion or the fall.
  if (!body.alive) {
    return;
  }

  // --- Environmental reaction (p4-t5, THE GATE gate point 4) ----------------
  // GDD 5.2/7.3: the rigged body reads the world at its head cells. Drowning
  // can KILL (dissolve) - bail immediately so we never drive a fresh corpse.
  // Burial PINS - suppress the horizontal walk this tick (the fall still runs
  // below, so a pinned body still settles as terrain shifts around it).
  const env = reactToEnvironment(body);
  if (env.dead) {
    return;
  }

  // --- Fire ignition (p4-t6, THE GATE gate point 3) -------------------------
  // GDD 7.3: flesh is flammable and fire spreads body-to-body. A living body in
  // contact with FIRE catches and sheds burning flesh; a sustained head/torso
  // catch can drive it dead. If it died, bail before driving a fresh corpse.
  checkFire(body);
  if (!body.alive) {
    return;
  }

  // --- Horizontal motion (p3-t3) -------------------------------------------
  // Driven by body.moveDir (set externally by t5's driver - no AI here).
  if (body.moveDir !== 0 && !env.pinned) {
    body.facing = body.moveDir; // always face the way we intend to move
    // GDD 7.2: a body that has lost a leg drops to a CRAWL - much slower. The
    // rig disables the limb (bodyCellsSolidAt already skips destroyed bones), so
    // here we only need the speed drop; an intact body walks at WALK_SPEED.
    const speed =
      body.lLegLost || body.rLegLost ? CRAWL_SPEED : WALK_SPEED;
    body.xRemainder += body.moveDir * speed;
    // Flush whole-cell crossings: move one cell per FULL unit of accumulated
    // intent and subtract that whole unit, so xRemainder stays in (-1, 1).
    // NOTE: the threshold MUST be 1 (a whole cell), not 0.5. With a 0.5
    // threshold and a `-= step` (whole-unit) decrement, an xRemainder landing
    // exactly on +/-0.5 flips sign (-0.5 -> +0.5 -> -0.5 ...) and, since a step
    // on open ground always succeeds, the loop never terminates (infinite spin).
    // WALK_SPEED < 1 so this is at most one step/tick, but loop for safety.
    while (Math.abs(body.xRemainder) >= 1) {
      const step: 1 | -1 = body.xRemainder >= 1 ? 1 : -1;
      if (tryHorizontalStep(body, step)) {
        body.xRemainder -= step;
      } else {
        body.xRemainder = 0; // wall: drop progress so we rest flush against it
        break;
      }
    }
  }

  // --- Buoyancy (playtest v0.9 Q/O, GDD 5.2/7.3) ----------------------------
  // A BUOYANT body (survivors) floats instead of settling to the bottom:
  //   - FULLY SUBMERGED (head in water) -> rise ONE whole cell toward the
  //     surface (swept, mirrors the fall - never into solid). If solid blocks
  //     the rise (trapped under a ceiling) it stays put and the drown clock in
  //     reactToEnvironment keeps running - trapped drowning stays meaningful.
  //   - AT THE FLOAT LINE (head clear, torso in water) -> the water SUPPORTS
  //     the body: no fall this tick. The body therefore sinks only until the
  //     torso wets, then bobs there with the head above the waterline - which
  //     is exactly why a rain/melt sheet no longer drowns the colony (O).
  // Non-buoyant bodies (zombies) skip this entirely: they sink through water
  // and walk the BOTTOM, unchanged from the pre-Q behaviour.
  if (body.buoyant) {
    if (boneInWater(body, 'head')) {
      if (!bodyCellsSolidAt(body, 0, -1)) {
        body.y -= 1; // rise toward the surface
      }
      body.vy = 0;
      body.grounded = false;
      return; // rising (or trapped): never also fall this tick
    }
    if (boneInWater(body, 'torso')) {
      body.vy = 0;
      body.grounded = false;
      return; // supported by the water: hold depth (float)
    }
  }

  // --- Ground probe + swept fall (p3-t2) -----------------------------------
  // Ground probe: grounded iff a step down by 1 cell would overlap solid
  // (i.e. there is solid directly beneath a foot pixel - GDD 5.1).
  if (bodyCellsSolidAt(body, 0, 1)) {
    body.grounded = true;
    body.vy = 0;
    return;
  }

  // Ungrounded -> accelerate downward, capped so we never accumulate enough
  // speed to skip past thin terrain in a single tick beyond what the swept
  // step loop below can resolve.
  body.grounded = false;
  body.vy = Math.min(body.vy + BODY_GRAVITY, BODY_FALL_MAX);

  // Swept fall: move down ONE cell at a time, stopping the instant the next
  // step would overlap solid. This is the no-tunnel guarantee.
  const steps = Math.floor(body.vy);
  for (let i = 0; i < steps; i++) {
    if (bodyCellsSolidAt(body, 0, 1)) break; // next step lands in solid -> stop
    body.y += 1;
  }

  // Recompute grounded after the move so the body rests cleanly on the floor
  // (lowest foot pixel exactly one cell above the solid, no overlap).
  if (bodyCellsSolidAt(body, 0, 1)) {
    body.grounded = true;
    body.vy = 0;
  }
}
