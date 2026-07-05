/**
 * game/camp.ts - the player-planted CAMP FLAG (playtest R9).
 *
 * "The game needs a way to assign a base ... they could then place a flag or
 * something to signify this is where the survivors should start building camp,
 * nothing should be built until this flag has been placed and if placed
 * somewhere else, the survivors should travel to it and start building camp
 * again."
 *
 * One global flag (or none). The flag is the GATE and the SITE for all
 * survivor-driven construction:
 *   - coopbuild.updateCoopBuild plans/streams NO shelter projects while the
 *     flag is null (player Plan-tool blueprints are unaffected - those are
 *     explicit player orders, not the autonomous camp).
 *   - shelter projects are SITED at the flag column, not the group centroid.
 *   - every placement bumps `version`; projects remember the version they were
 *     planned under, so moving the flag abandons the old camp (coopbuild's
 *     reconcile pass) and re-plans at the new site - and main re-homes the
 *     survivors so the colony walks over.
 *
 * Module-level state + reset(), mirroring resources.ts / buildqueue.ts /
 * shelter.ts. Pure data - no DOM, no grid access, no RNG.
 */

import { WORLD_W, WORLD_H } from '../config';
import { get, inBounds } from '../engine/grid';
import { isSolidForBody } from '../engine/materials';

/** The planted flag position (world cells), or null before first placement. */
let flag: { x: number; y: number } | null = null;

/** Bumped on every placement/move; 0 = never placed. */
let version = 0;

/** Reset to no-flag (new-game init / test harness). */
export function resetCampFlag(): void {
  flag = null;
  version = 0;
}

/**
 * Plant (or move) the camp flag at world cell (x, y), clamped in-bounds.
 * Bumps the version so consumers can detect the move.
 */
export function setCampFlag(x: number, y: number): void {
  flag = {
    x: Math.max(0, Math.min(WORLD_W - 1, Math.round(x))),
    y: Math.max(0, Math.min(WORLD_H - 1, Math.round(y))),
  };
  version++;
}

/**
 * Plant the flag at the tap point SNAPPED to the local surface: a tap in the
 * air drops the flag to stand on the first solid below; a tap on/inside the
 * ground raises it to the first open cell above the solid run. The stored y is
 * therefore always a STANDING row - exactly the anchor planShelter's downward
 * surface scan wants (a raw sky-row tap would otherwise site the camp on
 * whatever roof the sky sees first - the R8 floating-shelter bug shape).
 */
export function plantCampFlagAt(x: number, y: number): void {
  const cx = Math.max(0, Math.min(WORLD_W - 1, Math.round(x)));
  let cy = Math.max(0, Math.min(WORLD_H - 1, Math.round(y)));
  if (!inBounds(cx, cy)) return;
  if (isSolidForBody(get(cx, cy))) {
    while (cy > 0 && isSolidForBody(get(cx, cy))) cy--;
  } else {
    while (cy < WORLD_H - 1 && !isSolidForBody(get(cx, cy + 1))) cy++;
  }
  setCampFlag(cx, cy);
}

/** The current flag, or null if none has been planted. */
export function getCampFlag(): { x: number; y: number } | null {
  return flag;
}

/** Monotone placement counter (0 = never placed). */
export function getFlagVersion(): number {
  return version;
}
