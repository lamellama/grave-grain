/**
 * engine/simulation.ts — Falling-sand cellular update (Phase 1)
 * MVP scope: AIR + SAND + STONE + WATER (task p1-t4 adds water + density swap).
 *
 * Three correctness pillars (all load-bearing):
 *  - BOTTOM-UP scan (GDD Appendix B takeaway #1): the world is updated from the
 *    bottom row to the top each tick. A top-down scan would carry one grain down
 *    through every row in a single tick (teleporting) — bottom-up only ever lets
 *    a grain advance one row per tick.
 *  - EXPLICIT moved-guard (new in p1-t4): a per-cell "moved this tick" flag.
 *    For sand the bottom-up order was a free moved-guard (sand only moves DOWN,
 *    into already-processed rows). That invariant breaks for water — water moves
 *    SIDEWAYS within a row the scan has not finished, and density swaps push the
 *    lighter material UP into the current cell — so without an explicit flag a
 *    grain could be re-processed and skid multiple cells per tick. The flag
 *    makes "one action per cell per tick" hold for every material.
 *  - DENSITY swap (GDD §5.2): a heavier non-static grain swaps with a lighter,
 *    non-static cell below it — so sand (density 3) sinks through water
 *    (density 1) and the water rises above it. Stone (static/255) never moves.
 *    Falling into AIR is just the swap with the lightest material, so the same
 *    rule covers "fall" and "sink".
 */

import { WORLD_W, WORLD_H } from '../config';
import { material, idx } from './grid';
import { SAND, WATER, density, isStatic } from './materials';

/**
 * Tick parity counter. Drives the per-tick column scan-direction flip so neither
 * piling nor water flow shows a left/right drift bias (PLAN Phase 1:
 * "scan-direction flip per row each frame to kill left/right bias").
 */
let tick = 0;

/**
 * "Moved this tick" guard, one byte per cell (0 = free, 1 = already acted).
 * Cleared at the start of every step(). Any cell that has already moved or been
 * swapped this tick is skipped, and is never chosen as a swap target — this is
 * what prevents double-moves now that material travels sideways and swaps
 * upward within a single bottom-up pass.
 */
const moved = new Uint8Array(WORLD_W * WORLD_H);

/**
 * Advance the cellular simulation by one tick.
 *
 * Scan order is BOTTOM row (y = WORLD_H-1) → TOP row (y = 0), with the per-row
 * column direction flipped every tick to kill lateral bias (GDD App. B).
 */
export function step(): void {
  // Clear the moved-guard for the new tick.
  moved.fill(0);

  // Flip column scan direction every tick to avoid any lateral bias.
  const leftToRight = (tick & 1) === 0;

  for (let y = WORLD_H - 1; y >= 0; y--) {
    if (leftToRight) {
      for (let x = 0; x < WORLD_W; x++) {
        updateCell(x, y);
      }
    } else {
      for (let x = WORLD_W - 1; x >= 0; x--) {
        updateCell(x, y);
      }
    }
  }

  tick++;
}

/**
 * Dispatch a single cell to its material rule. Cells that already acted this
 * tick (fell into here, or were swapped up) are skipped by the moved-guard.
 */
function updateCell(x: number, y: number): void {
  if (moved[idx(x, y)]) {
    return;
  }
  const m = material[idx(x, y)];
  if (m === SAND) {
    updateSand(x, y);
  } else if (m === WATER) {
    updateWater(x, y);
  }
  // AIR is the empty target; STONE is static — neither has a rule.
}

/**
 * SAND rule (GDD §5.2): fall straight down (sinking through anything lighter and
 * non-static — AIR or WATER), otherwise spill into the two diagonals below in
 * random per-cell order to pile at the angle of repose. Sand never moves
 * horizontally, so a mound stays stable.
 */
function updateSand(x: number, y: number): void {
  const below = y + 1;

  // 1) Sink straight down through any lighter, non-static cell (AIR or WATER).
  if (trySwap(x, y, x, below)) {
    return;
  }

  // 2) Otherwise pile via the two diagonals below (random order, no side bias).
  const leftFirst = Math.random() < 0.5;
  const firstDx = leftFirst ? -1 : 1;
  const secondDx = leftFirst ? 1 : -1;

  if (trySwap(x, y, x + firstDx, below)) {
    return;
  }
  trySwap(x, y, x + secondDx, below);
}

/**
 * WATER rule (GDD §5.2: "flows, seeks level, never piles").
 * Fall if possible, otherwise spread sideways so a column collapses to a flat
 * sheet rather than piling. Down-diagonals are tried before straight sideways so
 * water prefers to keep descending while it spreads. Left/right order is
 * randomised per cell so the sheet has no drift bias.
 *
 * NOTE on leveling vs. diffusion: this is the simple, robust local rule (the
 * GDD/PLAN one). It guarantees the two hard requirements — water never piles and
 * a column collapses to a flat sheet. Its only artifact is that a *truly
 * isolated* water cell on flat ground will slowly random-walk (it has air on
 * both sides, so each side is a valid swap). That reads as harmless shimmer for
 * MVP; true pressure-based leveling (a multi-cell flow scan) is deferred to the
 * flooding work in a later phase. A pressure gate (only flow when water is
 * directly above) was tried and rejected here because it makes water form a
 * stable *mound* — which violates "never piles".
 */
function updateWater(x: number, y: number): void {
  const below = y + 1;

  // 1) Fall straight down through any lighter, non-static cell (AIR).
  if (trySwap(x, y, x, below)) {
    return;
  }

  const leftFirst = Math.random() < 0.5;
  const dx1 = leftFirst ? -1 : 1;
  const dx2 = leftFirst ? 1 : -1;

  // 2) Blocked below → spread to a lower diagonal first (keeps water descending).
  if (trySwap(x, y, x + dx1, below) || trySwap(x, y, x + dx2, below)) {
    return;
  }

  // 3) Still blocked → flow straight sideways to seek its level (never piles).
  if (trySwap(x, y, x + dx1, y)) {
    return;
  }
  trySwap(x, y, x + dx2, y);
}

/**
 * Density swap (GDD §5.2): move the grain at (sx,sy) into (tx,ty), swapping the
 * two cells, iff the target is in-bounds, has NOT acted this tick, and is a
 * LIGHTER, NON-STATIC material. Stone (static/255) is never displaced, so it is
 * what stops sand/water tunnelling through the floor. Both cells are flagged
 * moved so neither is re-processed this tick.
 *
 * The caller guarantees (sx,sy) is in-bounds and unmoved; we guard the target.
 * Returns true if the swap happened.
 */
function trySwap(sx: number, sy: number, tx: number, ty: number): boolean {
  if (tx < 0 || tx >= WORLD_W || ty < 0 || ty >= WORLD_H) {
    return false;
  }
  const t = idx(tx, ty);
  if (moved[t]) {
    return false;
  }
  const target = material[t];
  // Target must be displaceable: non-static AND strictly lighter than us.
  if (isStatic(target)) {
    return false;
  }
  const s = idx(sx, sy);
  if (density(target) >= density(material[s])) {
    return false;
  }
  // Swap the two cells (handles both "fall into AIR" and "sink through WATER").
  material[t] = material[s];
  material[s] = target;
  moved[t] = 1;
  moved[s] = 1;
  return true;
}
