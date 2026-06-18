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

// Phase 2 material density constants (GDD §5.2)
export const DENSITY_DIRT = 4;   // >= sand so dirt settles under sand; steepness handled later via spill chance
export const DENSITY_ASH = 2;    // light powder
export const DENSITY_FIRE = 0;   // fire behaves like air to the density swap
export const DENSITY_SMOKE = 0;  // gas, bubbles up

// DIRT spill chance (GDD §5.2: "dirt piles steeper than sand").
// Dirt falls straight down unconditionally (like sand), but only attempts its
// diagonal spill with this probability per tick. Fewer diagonal moves than sand
// → a narrower, steeper mound (steeper angle of repose). 1.0 would equal sand.
export const DIRT_SPILL_CHANCE = 0.3;

// Phase 2 structural integrity baselines (GDD §5.2)
export const WOOD_INTEGRITY = 60;
export const FOLIAGE_INTEGRITY = 10;

// FIRE state machine (GDD §5.2 "spreads to flammable neighbours, rises;
// consumes fuel, makes smoke" + §7.3 fire vulnerability/spread).
// FIRE_LIFETIME: ticks a fire cell burns before it expires (seeded into the
//   integrity slot as a countdown — see updateFire). Bounds the flame so it
//   never burns forever, even sitting over AIR with no fuel.
// FIRE_SPREAD_CHANCE: per-tick probability a fire cell ignites EACH adjacent
//   flammable (WOOD/FOLIAGE) neighbour.
// SMOKE_EMIT_CHANCE: on expiry, probability a fire cell puffs SMOKE instead of
//   leaving ASH (net: burned fuel leaves ash and emits some rising smoke).
export const FIRE_LIFETIME = 60;
export const FIRE_SPREAD_CHANCE = 0.25;
export const SMOKE_EMIT_CHANCE = 0.3;

// SMOKE/STEAM dissipation chance (GDD §5.2: "gas, rises, dissipates").
// Per-tick probability that a smoke cell vanishes (→ AIR). Drives the gradual
// thinning of a smoke plume so it trends to nothing over a bounded number of
// ticks. Mass is intentionally NOT conserved (MVP scope).
export const SMOKE_DISSIPATE = 0.02;

// Phase 3 — Hybrid character locomotion (GDD §5.1, §6.1, §14 Milestone 0).
// The living body is a rigged pixel sprite using cheap, reliable rigged-
// character motion (NOT soft-body). These are seeds for t2/t3; t1 only needs
// BODY_W/BODY_H to size the authored figure.

// Horizontal walk speed in cells/tick.
export const WALK_SPEED = 0.3;
// Max height (cells) the body can step up in one move (gentle-slope climbing).
export const STEP_UP_MAX = 1;
// Downward acceleration applied to the body each tick when not grounded.
export const BODY_GRAVITY = 0.4;
// Terminal fall speed (cells/tick) so a falling body never tunnels terrain.
export const BODY_FALL_MAX = 4;

// Authored body bounding box, in world cells. The figure is drawn at world-cell
// resolution (GDD §14: "art direction is load-bearing") so released pixels are
// indistinguishable from sim cells in Phase 4.
export const BODY_W = 6;
export const BODY_H = 12;

// Default spawn position for the lone Milestone-0 survivor (feet-centre anchor).
export const BODY_SPAWN_X = 200;
export const BODY_SPAWN_Y = 100;

// Phase-3 test terrain (p3-t5) — uneven ground near BODY_SPAWN_X with a pit
// and a gentle 1-cell step so locomotion is exercisable in the dev server.
// Throwaway scaffold; replaced by proper level seeding in Phase 5.

// Y-row of the main stone floor (cells increase downward; body feet rest at
// P3_GROUND_Y - 1 when standing on it).
export const P3_GROUND_Y = 140;

// 1-cell step: additional stone at P3_GROUND_Y-1 from P3_STEP_X for P3_STEP_W cells.
// Body climbs it using STEP_UP_MAX (GDD §5.1 gentle-slope rule).
export const P3_STEP_X = 220;
export const P3_STEP_W = 20;

// Pit: gap in the ground from P3_PIT_X for P3_PIT_W cells, P3_PIT_DEPTH cells
// deeper than the main floor. Deeper than STEP_UP_MAX so the body cannot step
// out — pacer stall detection reverses direction instead.
export const P3_PIT_X = 260;
export const P3_PIT_W = 12;
export const P3_PIT_DEPTH = 3;

// Pacer x-bounds for the default back-and-forth script (cells).
export const P3_PACE_LEFT = 165;
export const P3_PACE_RIGHT = 340;

// Ticks without horizontal progress before the pacer flips direction.
export const P3_STALL_TICKS = 20;
