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

// Phase 4 — Shoot tool pick radius (THE GATE hand-test, GDD §14 / §7.2). Max
// distance (cells) from a clicked world cell to a bone's nearest pixel for that
// bone to be hit. A small slop so a click near a limb still registers.
export const SHOOT_PICK_RADIUS = 6;

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

// Phase 4 — Body materials (GDD §5.2 FLESH/BONE/BLOOD rows). Densities keep the
// gore pile readable: bone is heaviest (sinks/structures), flesh middling, blood
// is a thin near-weightless fluid that seeks its level and douses NOTHING.
export const DENSITY_FLESH = 3;
export const DENSITY_BONE = 5;
export const DENSITY_BLOOD = 1;
// Bone is "harder to destroy than flesh" (GDD §5.2) — used by Phase-4 damage.
export const BONE_INTEGRITY = 30;

// Phase 4 — Damage→cells handoff (THE GATE, GDD §5.1 #3, §7.2). On a hit that
// releases a bone, up to this many BLOOD cells are spat into free AIR cells
// around the bone's footprint so the shed limb bleeds (blood is a thin fluid
// that seeks its level and douses nothing).
export const BLOOD_PER_HIT = 4;

// Phase 4 — Emergent damage model (THE GATE, GDD §7.2). Torso loss "bleeds,
// weakens; enough loss triggers full disintegration": when the cumulative
// fraction of destroyed body pixels reaches this threshold on a TORSO hit, the
// whole body dissolves into falling cells (the Vagabond death-collapse, App. B).
export const TORSO_DISINTEGRATE_THRESHOLD = 0.5;

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
// Crawl speed in cells/tick (GDD §7.2: a body that loses a leg drops to a CRAWL,
// "much slower"). Used by locomotion when lLegLost || rLegLost. ~0.4× WALK_SPEED.
export const CRAWL_SPEED = 0.12;
// Max height (cells) the body can step up in one move (gentle-slope climbing).
export const STEP_UP_MAX = 1;
// Downward acceleration applied to the body each tick when not grounded.
export const BODY_GRAVITY = 0.4;
// Terminal fall speed (cells/tick) so a falling body never tunnels terrain.
export const BODY_FALL_MAX = 4;

// Phase 4 — Buried / drowned reaction (THE GATE gate point 4, GDD §5.2 / §7.3:
// "water drowns bodies when head submerged too long" / "buried by collapsing
// sand"). The rigged body READS the world at its head cells and reacts:
//   DROWN_TICKS: consecutive ticks the head may sit in WATER before the body
//     drowns and dissolves into the sim (the death-collapse, App. B). At
//     SIM_HZ=60 this is ~3 s underwater.
//   BURIAL_PIN: when solid non-fluid terrain (sand/dirt/stone) sits directly on
//     the head, the body is pinned — its horizontal walk is suppressed until it
//     is dug/settled free (falling/settling still resolves).
export const DROWN_TICKS = 180;
export const BURIAL_PIN = true;

// Phase 4 — Body ignition (THE GATE gate point 3, GDD §7.3: "flesh is
// flammable ... it spreads body-to-body"). Per non-destroyed bone, per tick,
// the probability that a LIVING body catches fire and sheds that bone when ANY
// of its flesh cells is orthogonally adjacent to a FIRE cell. Kept low so a
// brush with fire singes a limb gradually rather than vaporising the figure;
// the released flesh then ignites from the same fire via the normal sim, and a
// sustained head/torso catch cascades to death via the dissolve thresholds.
export const BODY_BURN_DAMAGE_CHANCE = 0.08;

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

// ---------------------------------------------------------------------------
// Phase 5 — survivors: needs, autonomy, pathfinding (GDD §6.1, §13)
// ---------------------------------------------------------------------------

// Full scale for every need bar (Hunger, Thirst).
export const NEED_MAX = 100;

// Hunger depletion per simulation tick (GDD §6.1).
export const HUNGER_RATE = 0.01;

// Thirst depletion per simulation tick — slightly faster than hunger (GDD §6.1).
export const THIRST_RATE = 0.015;

// Multiplier applied to both depletion rates while the survivor is moving
// (moveDir !== 0) — exertion drains needs faster (GDD §6.1).
export const EXERTION_RATE_MULT = 2.0;

// Additional thirst multiplier when any body cell is adjacent to FIRE (GDD §6.1).
export const HEAT_THIRST_MULT = 3.0;

// Hunger level below which the autonomy AI auto-overrides to seek food (GDD §6.1).
export const HUNGER_THRESHOLD = 35;

// Thirst level below which the autonomy AI auto-overrides to seek water (GDD §6.1).
export const THIRST_THRESHOLD = 35;

// Idle wander bound: max cell distance from the survivor's home point
// that the random wander goal may be placed (GDD §6.1).
export const WANDER_RADIUS = 40;

// Wander tuning (p5-t3, GDD §6.1 idle/wander). A wandering survivor steers its
// body toward a random goal column within WANDER_RADIUS of home, pausing on
// arrival before picking the next, so it drifts but stays near base.
//   WANDER_ARRIVE_DIST: |body.x - goal.x| (cells) at which the goal is reached.
//   WANDER_PAUSE_MIN/MAX: ticks the survivor idles (moveDir 0) on arrival before
//     choosing a new goal (randomised in this range for a less robotic gait).
//   WANDER_MAX_PURSUE_TICKS: give up on a goal it cannot reach (e.g. blocked by
//     terrain) after this many ticks, then pause and repick — keeps it bounded.
export const WANDER_ARRIVE_DIST = 2;
export const WANDER_PAUSE_MIN = 30;
export const WANDER_PAUSE_MAX = 120;
export const WANDER_MAX_PURSUE_TICKS = 240;

// Coarse navgrid cell size in world cells (GDD §13).
export const NAV_CELL = 4;

// Hunger restored by a single eat action (clamped to NEED_MAX).
export const EAT_RESTORE = 100;

// Thirst restored by a single drink action.
export const DRINK_RESTORE = 100;

// Duration of an eat action in ticks (survivor stands still while consuming).
export const EAT_TICKS = 60;

// Duration of a drink action in ticks.
export const DRINK_TICKS = 60;

// Distance in cells at which a nearby FIRE cell triggers the flee-fire behaviour.
export const FLEE_FIRE_RADIUS = 8;

// Reach (cells from the body anchor) at which a survivor can consume a resource
// it is standing beside (GDD §6.1). Tuned so the body drinks/eats from the bank
// or beside the bush WITHOUT overlapping it (body half-width ~3 + a little slop).
export const CONSUME_REACH = 4;

// Max distance (cells, Chebyshev) the autonomy AI scans outward from the body
// for the nearest WATER/FOLIAGE when self-preserving (GDD §6.1/§13). Bounded so
// a survivor with no resource in range gives up to wandering (and may die).
export const RESOURCE_SCAN_RADIUS = 200;

// Number of survivors spawned at the start of a game.
export const SURVIVOR_COUNT = 4;

// Spread radius (cells) around the home point used when positioning each
// survivor at spawn so they don't all stack on the same cell.
export const SURVIVOR_SPAWN_SPREAD = 12;

// Minimum ticks that must elapse between forced path recomputes for a survivor
// (GDD §13 navgrid — avoids repathing every tick on mutable terrain).
export const PATH_REPATH_COOLDOWN = 30;
