/**
 * game/buildqueue.ts — Global player blueprint queue (BQ-1, GDD §6.2 / §8)
 *
 * A DOM-free, pure data store: a bounded, deduplicated list of cells the player
 * has marked for construction. Blueprint objects are an OVERLAY only — they
 * represent the player's INTENT; no grid cells are written here. The builder
 * role (BQ-3) later calls placeStructure() to actualise each blueprint.
 *
 * MVP scope (GDD §14): data store only. No builder AI, no UI, no rendering,
 * no priorities, no multi-step construction.
 *
 * Mirrors the module-level state + exported functions pattern of resources.ts.
 */

import type { StructureKind } from './building';
import { STRUCTURES } from './building';
import { inBounds, get } from '../engine/grid';
import { BUILD_QUEUE_MAX } from '../config';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Blueprint {
  x: number;
  y: number;
  kind: StructureKind;
  /** True while a builder survivor has claimed this job (BQ-3). */
  reserved: boolean;
}

// ---------------------------------------------------------------------------
// Module-level queue (all blueprints start fresh)
// ---------------------------------------------------------------------------

const queue: Blueprint[] = [];

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** Returns the live queue array (read-only intent). */
export function getBlueprints(): Blueprint[] {
  return queue;
}

/** Returns the Blueprint at (x, y), or null if none is queued. */
export function blueprintAt(x: number, y: number): Blueprint | null {
  for (const bp of queue) {
    if (bp.x === x && bp.y === y) return bp;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/**
 * Add a blueprint for `kind` at (x, y).
 *
 * Rejects (returns false) if:
 *   - (x, y) is out of world bounds
 *   - a blueprint already exists at (x, y) (deduplication)
 *   - the queue has reached BUILD_QUEUE_MAX
 *   - the cell already contains the structure's material (nothing to build)
 *
 * Returns true and pushes the blueprint iff all checks pass.
 */
export function addBlueprint(x: number, y: number, kind: StructureKind): boolean {
  // 1. Bounds check
  if (!inBounds(x, y)) return false;

  // 2. Deduplication (any kind at the same cell)
  if (blueprintAt(x, y) !== null) return false;

  // 3. Capacity cap
  if (queue.length >= BUILD_QUEUE_MAX) return false;

  // 4. No-op guard: cell already equals the target material
  if (get(x, y) === STRUCTURES[kind].material) return false;

  queue.push({ x, y, kind, reserved: false });
  return true;
}

/**
 * Remove the blueprint at (x, y) if present.
 * Returns true iff a blueprint was removed.
 */
export function cancelBlueprintAt(x: number, y: number): boolean {
  const i = queue.findIndex(bp => bp.x === x && bp.y === y);
  if (i === -1) return false;
  queue.splice(i, 1);
  return true;
}

/**
 * Remove a specific blueprint object from the queue (identity match).
 * No-op if not present.
 */
export function removeBlueprint(bp: Blueprint): void {
  const i = queue.indexOf(bp);
  if (i !== -1) queue.splice(i, 1);
}

// ---------------------------------------------------------------------------
// Reservation helpers (used by builder role BQ-3)
// ---------------------------------------------------------------------------

/** Mark a blueprint as reserved by a builder survivor. No-op if not present. */
export function reserve(bp: Blueprint): void {
  bp.reserved = true;
}

/** Clear the reservation on a blueprint. No-op if not present. */
export function release(bp: Blueprint): void {
  bp.reserved = false;
}

// ---------------------------------------------------------------------------
// Test / reset helper (mirrors resetStockpile)
// ---------------------------------------------------------------------------

/** Empties the queue. Intended for test harnesses only. */
export function resetQueue(): void {
  queue.length = 0;
}
