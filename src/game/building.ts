/**
 * game/building.ts - Direct placement from stockpile (GDD 8, 15-Q4).
 *
 * Pure, DOM-free module: places ONE structure cell, atomically spending the
 * colony stockpile and notifying the navgrid. There is no build queue, no
 * blueprint, and no survivor construction (MVP scope, GDD 14) - the player
 * paints directly, and 15-Q4 "resolves toward scarcity": every placed cell
 * draws from gathered materials and decrements the stockpile.
 *
 * GDD 8 structures: Fence = WOOD (cheap, flammable, low integrity) is the
 * disposable line; Wall = STONE (high integrity, WALL_INTEGRITY) is "the real
 * barrier". Raw-material painting is a SEPARATE free tool and is not handled
 * here - this module only ever spends and only ever places fence/wall.
 *
 * Ordering is correctness-critical (the make-or-break of this task):
 *   spend (atomic) -> placeMaterial -> markTerrainEdit.
 * Spending before writing means we can never place without paying; writing the
 * grid before marking the navgrid means pathing/breaching always see the new
 * solid the moment it exists. Reversing either step breaks scarcity or pathing.
 */

import type { ResourceKind } from './resources';
import * as resources from './resources';
import { inBounds, get, placeMaterial } from '../engine/grid';
import { markTerrainEdit } from '../engine/navgrid';
import { WOOD, WALL, CAMPFIRE, DOOR, STONE } from '../engine/materials';
import {
  FENCE_COST,
  WALL_COST,
  CAMPFIRE_COST,
  DOOR_COST,
  STONE_BLOCK_COST,
} from '../config';

// ---------------------------------------------------------------------------
// Structure table (GDD 8)
// ---------------------------------------------------------------------------
// 'campfire' (VS-2 T-C) is placed through the same costed path as fence/wall: a
// single CAMPFIRE cell, spent atomically from the stockpile. placeMaterial
// leaves its integrity at 0, so simulation.updateCampfire auto-seeds the fuel
// countdown on first visit (the campfire is NOT a breach-integrity structure).
// 'door' (v0.10 playtest R8): a barred wooden DOOR cell - the living walk
// through, the undead must gnaw it down (DOOR_INTEGRITY seeds via placeMaterial).
// 'stone' (v0.11 playtest R): a LOOSE STONE BLOCK - placeMaterial seeds the
// STONE_LOOSE marker, so the placed cell FALLS under gravity and STACKS
// (build walls by piling from the ground). The toolbar Stone verb places this;
// WALL remains the precise breachable structure (Plan Wall / coop builders).
export type StructureKind = 'fence' | 'wall' | 'campfire' | 'door' | 'stone';

export const STRUCTURES: Record<
  StructureKind,
  { material: number; cost: Partial<Record<ResourceKind, number>> }
> = {
  fence: { material: WOOD, cost: FENCE_COST },
  wall: { material: WALL, cost: WALL_COST },
  campfire: { material: CAMPFIRE, cost: CAMPFIRE_COST },
  door: { material: DOOR, cost: DOOR_COST },
  stone: { material: STONE, cost: STONE_BLOCK_COST },
};

/** The per-cell cost of a structure kind (drops into resources.canAfford/spend). */
export function structureCost(kind: StructureKind): Partial<Record<ResourceKind, number>> {
  return STRUCTURES[kind].cost;
}

/** True if the stockpile can currently afford one cell of this structure. */
export function canPlace(kind: StructureKind): boolean {
  return resources.canAfford(STRUCTURES[kind].cost);
}

/**
 * Place ONE structure cell at (x,y), spending the stockpile atomically and
 * notifying the navgrid. Returns true iff a cell was placed (and paid for).
 *
 * Single cell only - the toolbar drag (task 8-3) calls this per cell; there is
 * no disc brush here. Strict order (see file header): bounds -> no-op repaint
 * guard -> atomic spend -> grid write -> navgrid mark.
 */
export function placeStructure(x: number, y: number, kind: StructureKind): boolean {
  // 1. Bounds: never spend on an off-world cell.
  if (!inBounds(x, y)) return false;

  const { material, cost } = STRUCTURES[kind];

  // 2. Nicety: if the cell ALREADY holds this structure's material, do nothing
  //    and charge nothing - don't double-pay to repaint an identical cell.
  if (get(x, y) === material) return false;

  // 3. Atomic spend: bails (spending nothing) if unaffordable. Must precede the
  //    grid write so we can never place a cell without paying for it.
  if (!resources.spend(cost)) return false;

  // 4. Write the grid (seeds baseIntegrity for hasIntegrity materials).
  placeMaterial(x, y, material);

  // 5. Notify the navgrid so pathing/breaching see the new solid immediately.
  markTerrainEdit(x, y);

  return true;
}
