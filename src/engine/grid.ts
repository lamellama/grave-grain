/**
 * engine/grid.ts - Data-oriented cell storage
 * Cells live in flat typed arrays for performance (GDD 13, AGENTS 4).
 * One Uint8Array for material, one for integrity (unused until Phase 2).
 */

import { WORLD_W, WORLD_H, STONE_LOOSE, DIRT_LOOSE } from '../config';
import { MATERIALS, STONE, DIRT } from './materials';
import { markCellActive } from './chunks';

/**
 * Get the linear index of a cell at (x, y) in the grid.
 * Formula: idx = y * WORLD_W + x
 */
export function idx(x: number, y: number): number {
  return y * WORLD_W + x;
}

/**
 * Check if coordinates are within world bounds.
 */
export function inBounds(x: number, y: number): boolean {
  return x >= 0 && x < WORLD_W && y >= 0 && y < WORLD_H;
}

// Material grid: stores material ID at each cell
// Initialized to 0 (AIR). Will be populated by the simulation.
export const material = new Uint8Array(WORLD_W * WORLD_H);

// Integrity grid: parallel array for structure durability (Phase 2+).
// Allocated now, unused until Phase 2.
export const integrity = new Uint8Array(WORLD_W * WORLD_H);

/**
 * Get the material at (x, y).
 * Returns 0 (AIR) if out of bounds.
 */
export function get(x: number, y: number): number {
  if (!inBounds(x, y)) {
    return 0; // AIR
  }
  return material[idx(x, y)];
}

/**
 * Set the material at (x, y).
 * Silently no-op if out of bounds (safe write).
 */
export function set(x: number, y: number, value: number): void {
  if (!inBounds(x, y)) {
    return; // Out of bounds write is safe no-op
  }
  material[idx(x, y)] = value;
  // Wake the chunk (Phase 11): player edits, worldgen post-fixups, breaching,
  // body release and ignite all route through here, so the right chunks
  // re-activate NEXT tick. Cheap; harmless if the value is unchanged.
  markCellActive(x, y);
}

/**
 * Get the integrity at (x, y).
 * Returns 0 if out of bounds.
 */
export function getIntegrity(x: number, y: number): number {
  if (!inBounds(x, y)) {
    return 0;
  }
  return integrity[idx(x, y)];
}

/**
 * Set the integrity at (x, y).
 * Silently no-op if out of bounds.
 */
export function setIntegrity(x: number, y: number, value: number): void {
  if (!inBounds(x, y)) {
    return;
  }
  integrity[idx(x, y)] = value;
  // Integrity-only edits (breaching chips, fire-lifetime seeding) also count as
  // a cell change and must wake the chunk (Phase 11).
  markCellActive(x, y);
}

/**
 * Place a material at (x, y), seeding its baseIntegrity into the integrity array.
 * Clearing (id=AIR=0) automatically resets integrity to 0.
 * Bounds-safe: silently no-ops if out of bounds.
 *
 * PLACED STONE is a LOOSE BLOCK (playtest v0.11 R): the player's paint path
 * routes through here, and painted stone must fall-and-stack (below-support)
 * rather than hang off lateral contact like NATIVE worldgen rock. STONE has
 * hasIntegrity=false, so its integrity slot is free to carry the marker
 * (worldgen's own put() and raw grid.set leave it 0 = native). Since round 11
 * the STONE_LOOSE seed doubles as the block's GNAW DURABILITY (breaching).
 *
 * PLACED DIRT is likewise LOOSE (round 11, DIRT_LOOSE): painted dirt keeps the
 * old powder fall+spill feel, while unmarked NATIVE worldgen dirt is cohesive
 * (falls straight down only - see simulation.updateDirt).
 */
export function placeMaterial(x: number, y: number, id: number): void {
  if (!inBounds(x, y)) {
    return;
  }
  set(x, y, id);
  const mat = MATERIALS[id];
  setIntegrity(
    x,
    y,
    mat?.hasIntegrity
      ? mat.baseIntegrity
      : id === STONE
        ? STONE_LOOSE
        : id === DIRT
          ? DIRT_LOOSE
          : 0,
  );
}
