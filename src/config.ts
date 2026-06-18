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

// Phase 1 tunables — Falling-sand core (GDD §5.2)

// Gravity simulation steps per frame
export const GRAVITY_STEPS = 1;

// Brush radius for placing/erasing materials (cells)
export const BRUSH_RADIUS = 3;

// Material density constants (GDD §5.2 density rule)
// Heavier materials displace lighter ones below them.
// 255 = immovable/static (stone, bedrock).
export const DENSITY_AIR = 0;
export const DENSITY_WATER = 1;
export const DENSITY_SAND = 3;
export const DENSITY_STONE = 255;

// Phase 1 test scene (p1-t4) — a STONE floor holding a body of WATER, with a
// SAND blob suspended just above the water. On run: the water seeks its level
// (flat sheet, never piles) and the sand sinks through the water to the bottom
// while the water rises above it (GDD §5.2 density swap).
// Throwaway debug scaffold; replaced by player placement once tools land.
export const TEST_FLOOR_TOP = WORLD_H - 30; // first stone row, counted up from the bottom
export const TEST_FLOOR_THICKNESS = 6; // rows of stone

// Water body resting on the floor (centred).
export const TEST_WATER_W = 140; // width of the water body (cells)
export const TEST_WATER_H = 18; // height of the water body (cells)

// Sand blob dropped into the water from just above its surface (centred).
export const TEST_SAND_W = 30; // width of the sand blob (cells)
export const TEST_SAND_H = 18; // height of the sand blob (cells)
export const TEST_SAND_GAP = 8; // air gap between blob bottom and water surface
