/**
 * engine/navgrid.ts — Coarse navigation grid over mutable terrain (GDD §13).
 *
 * Pathfinding on a falling-sand world is the phase's make-or-break: terrain
 * changes constantly, so we can NOT re-plan against the full per-cell grid every
 * tick. GDD §13's prescription is a **coarse navgrid for routing + local
 * steering**, with **paths invalidated only by LOCAL edits near the path, not
 * globally**. This module is the coarse grid half (the router lives in
 * game/pathfinding.ts); rigged bodies path as points over it (GDD §5.1).
 *
 * Each coarse cell covers NAV_CELL×NAV_CELL world cells. A coarse cell is
 * *walkable* iff it contains a **standable surface**: a column where a floor
 * cell (isSolidForBody) has at least BODY_H non-solid (air/water-passable) cells
 * above it — i.e. a body could stand there with headroom. We store the topmost
 * such floor row (`surfaceY`) so the router can test step-up/drop traversability
 * between neighbours against Phase-3 locomotion limits.
 *
 * **Local invalidation** is driven by a per-coarse-cell `epoch` (Uint32):
 * `markTerrainEdit(x,y)` recomputes ONLY the coarse cells an edit at (x,y) can
 * affect (its own cell plus the cells below it within BODY_H rows, since a
 * floor's headroom is read from the cells above it) and bumps their epochs. The
 * router records the epochs of the cells its path crosses; an edit elsewhere
 * touches different cells, so it can never make a distant path look stale.
 *
 * DOM-free, data-oriented (flat typed arrays — GDD §13, AGENTS §4); no per-cell
 * objects. Sampled from the live `material` grid.
 */

import { WORLD_W, WORLD_H, NAV_CELL, BODY_H } from '../config';
import { material, idx } from './grid';
import { isSolidForBody } from './materials';

// Coarse grid dimensions: one node per NAV_CELL×NAV_CELL block of world cells.
export const NAV_W = Math.ceil(WORLD_W / NAV_CELL);
export const NAV_H = Math.ceil(WORLD_H / NAV_CELL);

// Per-coarse-cell state (flat typed arrays, indexed cy*NAV_W + cx).
//   walkable : 1 if the block contains a standable surface, else 0.
//   surface  : world-y of the TOPMOST standable floor row (-1 if not walkable).
//   epoch    : bumped whenever the cell is recomputed by markTerrainEdit; the
//              router compares stored vs current epochs to detect LOCAL staleness.
const walkable = new Uint8Array(NAV_W * NAV_H);
const surface = new Int32Array(NAV_W * NAV_H);
const epoch = new Uint32Array(NAV_W * NAV_H);

/** Linear index of a coarse cell. */
function cidx(cx: number, cy: number): number {
  return cy * NAV_W + cx;
}

/** Map a world cell to the coarse cell that contains it. */
export function coarseOf(x: number, y: number): { cx: number; cy: number } {
  return { cx: Math.floor(x / NAV_CELL), cy: Math.floor(y / NAV_CELL) };
}

function inCoarseBounds(cx: number, cy: number): boolean {
  return cx >= 0 && cx < NAV_W && cy >= 0 && cy < NAV_H;
}

/**
 * Is the world cell at (x,y) a *standable surface*? I.e. the cell is solid to a
 * body (the floor) AND the BODY_H cells directly above it are all non-solid
 * (headroom for the body to stand). Out-of-bounds reads come back as AIR
 * (non-solid) from grid.get semantics, which is the correct "open sky" answer
 * near the top of the world. Headroom is purely per-column, which is why an edit
 * only ever affects standability within its own world column.
 */
function isStandable(x: number, y: number): boolean {
  if (y < 0 || y >= WORLD_H || x < 0 || x >= WORLD_W) return false;
  if (!isSolidForBody(material[idx(x, y)])) return false; // must be a floor
  for (let h = 1; h <= BODY_H; h++) {
    const ay = y - h;
    if (ay < 0) break; // open sky above → remaining headroom is clear
    if (isSolidForBody(material[idx(x, ay)])) return false; // ceiling too low
  }
  return true;
}

/**
 * Recompute one coarse cell from the live grid: walkable iff any column in the
 * block has a standable surface, and surface = the TOPMOST such floor row
 * (smallest y) across the block. Scanning each column top-down and taking the
 * first standable row gives that column's highest surface; we keep the global
 * minimum so the stored surface is the highest place a body could stand here.
 */
function computeCell(cx: number, cy: number): void {
  const x0 = cx * NAV_CELL;
  const y0 = cy * NAV_CELL;
  const x1 = Math.min(x0 + NAV_CELL, WORLD_W);
  const y1 = Math.min(y0 + NAV_CELL, WORLD_H);

  let best = -1; // topmost standable floor row found (smallest y)
  for (let x = x0; x < x1; x++) {
    for (let y = y0; y < y1; y++) {
      if (isStandable(x, y)) {
        if (best === -1 || y < best) best = y;
        break; // first standable from the top is this column's highest surface
      }
    }
  }

  const i = cidx(cx, cy);
  walkable[i] = best === -1 ? 0 : 1;
  surface[i] = best;
}

/**
 * Full resample of the whole navgrid from the live `material` grid. Call once at
 * startup and any time terrain changes wholesale (e.g. worldgen). O(world); not
 * for per-edit use — that's what markTerrainEdit is for. Epochs are left intact
 * (a global rebuild is not a "local edit" and is not meant to flag existing
 * paths stale; callers that rebuild wholesale should re-plan explicitly).
 */
export function rebuildNavgrid(): void {
  for (let cy = 0; cy < NAV_H; cy++) {
    for (let cx = 0; cx < NAV_W; cx++) {
      computeCell(cx, cy);
    }
  }
}

/**
 * Notify the navgrid of a single world-cell edit at (x,y) (GDD §13 local
 * invalidation). Recomputes ONLY the coarse cells the edit can affect and bumps
 * their epochs. Because a floor's headroom is read from the BODY_H cells ABOVE
 * it (all in the same world column), an edit at row y can change the standability
 * of floors in rows [y, y+BODY_H] of column x — and of no other column. So the
 * affected coarse cells are a short vertical strip in coarse-column floor(x/NAV):
 * from the edit's coarse row down through the coarse row of (y+BODY_H). This is
 * strictly local; an edit far from a path can never bump a path cell's epoch.
 */
export function markTerrainEdit(x: number, y: number): void {
  if (x < 0 || x >= WORLD_W || y < 0 || y >= WORLD_H) return;
  const cx = Math.floor(x / NAV_CELL);
  const cyTop = Math.floor(y / NAV_CELL);
  const cyBot = Math.min(Math.floor((y + BODY_H) / NAV_CELL), NAV_H - 1);
  for (let cy = cyTop; cy <= cyBot; cy++) {
    computeCell(cx, cy);
    epoch[cidx(cx, cy)]++; // bump: any path crossing/adjacent here is now stale
  }
}

/** Is the coarse cell walkable (contains a standable surface)? */
export function isWalkable(cx: number, cy: number): boolean {
  if (!inCoarseBounds(cx, cy)) return false;
  return walkable[cidx(cx, cy)] === 1;
}

/** World-y of the coarse cell's topmost standable floor row (-1 if none). */
export function surfaceY(cx: number, cy: number): number {
  if (!inCoarseBounds(cx, cy)) return -1;
  return surface[cidx(cx, cy)];
}

/** Current edit-epoch of a coarse cell (for path staleness comparison). */
export function epochAt(cx: number, cy: number): number {
  if (!inCoarseBounds(cx, cy)) return 0;
  return epoch[cidx(cx, cy)];
}
