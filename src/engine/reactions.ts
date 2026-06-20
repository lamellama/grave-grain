/**
 * engine/reactions.ts — Cross-material adjacency reactions (Phase 2, GDD §5.2)
 *
 * A single pass that applies the interactions which depend on two DIFFERENT
 * materials being neighbours (as opposed to a material's own fall/flow rule,
 * which lives in simulation.ts). It runs ONCE per tick, at the very start of
 * step() — before the movement scan — reading the start-of-tick grid so a
 * reaction never fires on a half-moved mid-scan state (see step() for the full
 * rationale). It shares simulation's `moved`-guard so a cell it consumes is
 * skipped by the movement scan that follows.
 *
 * MVP scope (GDD §5.2 "Material interactions"):
 *
 *  1. water + fire → steam + extinguish  ........... IMPLEMENTED below.
 *     A FIRE cell orthogonally adjacent to WATER becomes SMOKE (which doubles as
 *     steam) and its fire-lifetime is cleared, so it dies on this tick instead
 *     of aging out over FIRE_LIFETIME ticks. This is what makes a watered fire
 *     die measurably faster than a free burn (the phase Done-when).
 *
 *     Water consumption: the adjacent WATER is NOT consumed — it stays and keeps
 *     dousing further fire on later ticks. (Picking "water persists" keeps the
 *     douse robust: a small pool can extinguish a large fire front, matching the
 *     "water douses fire" intent. Mass non-conservation is already accepted for
 *     smoke/steam in MVP.)
 *
 *  2. undermined sand/dirt → collapse  ............. NO EXTRA RULE NEEDED.
 *     Falling-sand cells have no cohesion: in updateSand/updateDirt a grain only
 *     rests when the cell BELOW it is blocked (a non-lighter / static material)
 *     AND both below-diagonals are blocked. A grain can therefore never rest
 *     over AIR — remove its support and it falls (or diagonally spills) on the
 *     next tick. So an "unsupported overhang/ledge" cannot persist: the existing
 *     fall rule already collapses it. Adding a lateral-collapse nudge here would
 *     be redundant, so COLLAPSE_CHANCE is intentionally NOT introduced.
 *
 *  3. water + dirt → mud  .......................... DEFERRED (post-MVP).
 *     Would require inventing a MUD material; out of scope for this task.
 */

import { WORLD_W, WORLD_H, CHUNK_SIZE } from '../config';
import { material, idx, set, setIntegrity } from './grid';
import { moved } from './simulation';
import {
  isChunkingEnabled,
  isActiveThisTick,
  CHUNK_COLS,
  CHUNK_ROWS,
} from './chunks';
import { WATER, FIRE, SMOKE } from './materials';

/**
 * Is the cell at (x, y) WATER? Bounds-safe (out-of-bounds reads as not-water).
 */
function isWater(x: number, y: number): boolean {
  if (x < 0 || x >= WORLD_W || y < 0 || y >= WORLD_H) {
    return false;
  }
  return material[idx(x, y)] === WATER;
}

/**
 * Apply all adjacency reactions for this tick (GDD §5.2). Single full-grid pass.
 *
 * Currently only the water+fire extinguish path: any FIRE cell with WATER in one
 * of its four orthogonal neighbours is converted to SMOKE (steam), its reused
 * fire-lifetime slot cleared, and the cell claimed in the shared moved-guard so
 * the movement scan that follows skips it this tick.
 *
 * Scan direction is irrelevant: the reaction only reads WATER (which this pass
 * never creates or removes) and only writes the FIRE→SMOKE cell, so no fire's
 * outcome depends on another fire processed earlier in the same pass.
 */
export function reactions(): void {
  // Chunked path (Phase 11): only active chunks can hold a FIRE cell whose state
  // could change this tick. A FIRE cell ages every tick, so it ALWAYS keeps its
  // own chunk active (simulation.updateFire wakes it) — therefore iterating the
  // active chunks visits every FIRE the full scan would, in any order (this pass
  // is order-independent: it only reads WATER, which it never modifies). Result
  // is byte-identical to the full scan. When chunking is OFF, scan everything.
  if (isChunkingEnabled()) {
    for (let cr = 0; cr < CHUNK_ROWS; cr++) {
      for (let cc = 0; cc < CHUNK_COLS; cc++) {
        if (!isActiveThisTick(cc, cr)) continue;
        const x0 = cc * CHUNK_SIZE;
        const x1 = Math.min(x0 + CHUNK_SIZE, WORLD_W);
        const y0 = cr * CHUNK_SIZE;
        const y1 = Math.min(y0 + CHUNK_SIZE, WORLD_H);
        for (let y = y0; y < y1; y++) {
          for (let x = x0; x < x1; x++) reactCell(x, y);
        }
      }
    }
  } else {
    for (let y = 0; y < WORLD_H; y++) {
      for (let x = 0; x < WORLD_W; x++) reactCell(x, y);
    }
  }
}

/**
 * Apply the water+fire→steam reaction at a single cell (GDD §5.2). No-op unless
 * the cell is FIRE with WATER in an orthogonal neighbour. Order-independent:
 * reads only WATER (untouched here) and writes only the FIRE→SMOKE cell.
 */
function reactCell(x: number, y: number): void {
  const i = idx(x, y);
  if (material[i] !== FIRE) return;
  // water + fire → steam + extinguish (GDD §5.2): orthogonal contact only.
  if (
    isWater(x - 1, y) ||
    isWater(x + 1, y) ||
    isWater(x, y - 1) ||
    isWater(x, y + 1)
  ) {
    set(x, y, SMOKE); // fire becomes rising steam at the contact
    setIntegrity(x, y, 0); // clear the reused fire-lifetime slot
    moved[i] = 1; // claim the cell — movement scan skips it this tick
  }
}
