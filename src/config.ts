/**
 * config.ts — Gravegrain Phase 0 constants
 * All magic numbers live here for easy tuning.
 */

// Cell size in pixels (chunky cells)
export const CELL_SIZE = 6;

// World dimensions in cells
// WORLD_W is set to make the world several screens wide (~3–5 screens)
// At 1920px (standard desktop width) and CELL_SIZE 6: ~320 cells fit per screen.
// 1280 cells = ~4 screens wide, giving plenty of horizontal scrolling space.
export const WORLD_W = 1280;
export const WORLD_H = 240;

// Simulation frequency (ticks per second)
export const SIM_HZ = 60;

// Pan speed (multiplicative scale for camera movement via pointer drag)
// Adjust to feel responsive but not twitchy.
export const PAN_SPEED = 1.0;
