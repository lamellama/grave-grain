/**
 * game/lod.ts — Body Level-of-Detail throttle (task 11-3, GDD §13 "LOD for
 * distant/idle bodies").
 *
 * A body that is BOTH far off-screen AND idle is doing nothing the player can
 * see, so its controller (updateSurvivor / updateZombie) runs only every
 * BODY_LOD_THROTTLE-th tick instead of every tick. The body simply doesn't move
 * on the skipped ticks — invisible and cheap for a distant idler.
 *
 * This is a GATE on WHEN the controller runs — it never rewrites locomotion. A
 * body is NEVER throttled when it is any of:
 *   - on-screen (or within BODY_LOD_OFFSCREEN_MARGIN of the visible window),
 *   - mid-fall (not grounded) — so no body freezes in mid-air / tunnels,
 *   - pursuing/attacking (zombie state 'attack'),
 *   - self-preserving (survivor behaviour ≠ 'wander', or it has a role job),
 *   - being attacked (an opposing alive body is within melee adjacency).
 * Those update every tick: no missed combat, no missed fall, no missed
 * needs-death for anything the player could possibly be watching.
 *
 * DOM-free pure logic so main wires it in and the headless test calls it
 * directly. `Body`/`Survivor`/`Zombie` are imported as TYPES only (no runtime
 * cycle); `bodiesAdjacent` is the shared melee proximity test.
 */

import type { Body } from '../characters/body';
import type { Survivor } from '../characters/survivor';
import type { Zombie } from '../characters/zombie';
import { bodiesAdjacent } from './combat';
import { BODY_LOD_OFFSCREEN_MARGIN, BODY_LOD_THROTTLE } from '../config';

/** The visible world window in CELLS (camera + viewport), used by isFar(). */
export interface LodWindow {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/**
 * Build the visible cell window from the camera (top-left, in cells) and the
 * viewport size in pixels at the current effective cell size. The window is the
 * range of world cells currently on screen; isFar() then pads it by the margin.
 */
export function lodWindow(
  camX: number,
  camY: number,
  viewportWidthPx: number,
  viewportHeightPx: number,
  cellPx: number,
): LodWindow {
  const visW = viewportWidthPx / cellPx;
  const visH = viewportHeightPx / cellPx;
  return { minX: camX, maxX: camX + visW, minY: camY, maxY: camY + visH };
}

/**
 * Is (x, y) more than BODY_LOD_OFFSCREEN_MARGIN cells OUTSIDE the visible
 * window? Cells inside the window or within the margin band around it are NOT
 * far (they update every tick so nothing pops as it scrolls into view).
 */
export function isFar(x: number, y: number, win: LodWindow): boolean {
  const m = BODY_LOD_OFFSCREEN_MARGIN;
  return (
    x < win.minX - m ||
    x > win.maxX + m ||
    y < win.minY - m ||
    y > win.maxY + m
  );
}

/**
 * Idle = the controller is doing nothing reactive. A survivor is idle only when
 * it is plain wandering (behaviour 'wander') AND has no role job — anything
 * seeking water/food, fleeing fire, consuming, or working a role is NOT idle.
 */
export function survivorIsIdle(s: Survivor): boolean {
  return s.behaviour === 'wander' && s.role === 'none';
}

/** Idle = a zombie that is meandering, not pursuing/attacking a survivor. */
export function zombieIsIdle(z: Zombie): boolean {
  return z.state === 'idle';
}

/** Is `b` within melee adjacency of any ALIVE body in `threats`? */
function beingAttacked(b: Body, threats: Body[]): boolean {
  for (const t of threats) {
    if (t === b || !t.alive) continue;
    if (bodiesAdjacent(b, t)) return true;
  }
  return false;
}

/**
 * Should this body's controller RUN this tick? `idle` is the controller-specific
 * idleness flag, `threats` the opposing alive bodies (zombies for a survivor,
 * survivors for a zombie). Eligible-to-throttle iff: alive, grounded, idle, far,
 * and not being attacked. Eligible bodies run only on the keyed slot
 * (tick + index) % BODY_LOD_THROTTLE === 0; everything else runs every tick.
 */
function shouldRun(
  b: Body,
  index: number,
  idle: boolean,
  win: LodWindow,
  threats: Body[],
  tick: number,
): boolean {
  if (!b.alive) return true; // dead bodies fall through to the controller guard
  const throttleEligible =
    b.grounded && idle && isFar(b.x, b.y, win) && !beingAttacked(b, threats);
  if (!throttleEligible) return true;
  // Stagger by index so far idle bodies don't all wake on the same tick.
  return (tick + index) % BODY_LOD_THROTTLE === 0;
}

/** LOD gate for a survivor controller (threats = the alive zombie bodies). */
export function survivorShouldRun(
  s: Survivor,
  index: number,
  win: LodWindow,
  zombieBodies: Body[],
  tick: number,
): boolean {
  return shouldRun(s.body, index, survivorIsIdle(s), win, zombieBodies, tick);
}

/** LOD gate for a zombie controller (threats = the alive survivor bodies). */
export function zombieShouldRun(
  z: Zombie,
  index: number,
  win: LodWindow,
  survivorBodies: Body[],
  tick: number,
): boolean {
  return shouldRun(z.body, index, zombieIsIdle(z), win, survivorBodies, tick);
}
