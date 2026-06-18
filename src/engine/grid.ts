/**
 * engine/grid.ts — Data-oriented cell storage
 * Cells live in flat typed arrays for performance (GDD §13, AGENTS §4).
 * One Uint8Array for material, one for integrity (unused until Phase 2).
 */

import { WORLD_W, WORLD_H } from '../config';

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
}
