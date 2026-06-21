/**
 * config.ts — Gravegrain Phase 0 constants
 * All magic numbers live here for easy tuning.
 */

import type { ResourceKind } from './game/resources';

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

// Phase 10 — Gesture classification constants (task 10-4, GDD §12.3).
// TAP_MAX_MOVE_PX: pointer must stay within this radius (screen px) to be a tap.
// LONG_PRESS_MS: held ≥ this duration without moving = long-press.
export const TAP_MAX_MOVE_PX = 10;
export const LONG_PRESS_MS = 450;

// Phase 10 — Camera zoom (task 10-3, GDD §12.3/§12.4). Zoom multiplies the
// effective cell size (how many screen px a world cell occupies). It is NOT a
// ctx transform and NOT a devicePixelRatio multiply — the renderer keeps the
// ImageData == backing-store, putImageData(0,0) invariant. Cells stay chunky:
// at ZOOM_MIN the effective cell is CELL_SIZE*0.5 = 3px (still >1, never
// sub-pixel). Anchor-based zoom keeps the world point under the gesture stable.
export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 3;
export const ZOOM_STEP = 0.15;
export const ZOOM_DEFAULT = 1;

// Phase 1 tunables — Falling-sand core (GDD §5.2)

// Phase 11 (task 11-1) — Deterministic cellular-sim RNG seed (GDD §13, App. B).
// The falling-sand update must be a PURE function of (initial grid state + tick)
// so two runs of the same scene are byte-identical — the precondition for
// proving the chunked sim (11-2) is behaviour-preserving. Every per-cell random
// decision (diagonal order, dirt spill, water flow order, smoke dissipate, fire
// spread, smoke emit) is drawn from simRand(x, y, salt) which hashes
// (x, y, tick, SIM_RNG_SEED, salt) instead of calling the global Math.random().
// This makes a cell's roll INDEPENDENT of how many other cells were processed,
// so a chunked scan that skips settled chunks draws the SAME randoms as a full
// scan. The exact uint32 value is arbitrary (a well-mixed odd constant — the
// golden-ratio prime 0x9e3779b1); changing it only reshuffles the noise field.
export const SIM_RNG_SEED = 0x9e3779b1;

// Phase 11 (task 11-4) — Breach visualisation (GDD §7.4 / §12 UX readability).
// BREACH_DARKEN_MAX: fraction a zero-integrity structure cell is darkened toward
//   (full integrity = factor 1.0; near-0 = factor ≈ 1-BREACH_DARKEN_MAX).
// CHIP_FLASH_TICKS: number of simulation ticks a freshly-chipped cell stays
//   bright/highlighted in the renderer before fading to its darkened colour.
// UNDER_ATTACK_ALERT: enable the off-screen "structure under attack" indicator
//   in the HUD (← / → edge arrows when a breach is happening off-screen).
export const BREACH_DARKEN_MAX = 0.6;
export const CHIP_FLASH_TICKS = 12;
export const UNDER_ATTACK_ALERT = true;

// Phase 11 (task 11-2) — Chunk size for the dirty-rect cellular update (GDD §13,
// App. B). The world is partitioned into CHUNK_SIZE×CHUNK_SIZE chunks; step()
// processes only chunks that had activity last tick (or were edited), skipping
// settled regions. 32 is the Noita-standard chunk edge — large enough that
// interior changes stay inside one chunk (so only border cells wake a neighbour,
// keeping the dirty-rect cheap), small enough that a localised disturbance wakes
// only a handful of chunks. WORLD_W (1280) is a multiple of 32; WORLD_H (240) is
// not, so the bottom chunk-row is partial (16 rows) — handled by min-clamping.
export const CHUNK_SIZE = 32;

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
export const STEP_UP_MAX = 2; // cells a body steps up in one move (climb gentle bumps; <4 so fences/walls still block) — GDD §5.1, playtest #2
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
export const HUNGER_THRESHOLD = 50; // below this -> auto-seek food (raised 35->50 for more buffer; playtest: "go get it rather than die")

// Thirst level below which the autonomy AI auto-overrides to seek water (GDD §6.1).
export const THIRST_THRESHOLD = 50; // below this -> auto-seek water (raised 35->50 for more buffer; playtest)

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

// Max A* path attempts per nearest-REACHABLE-resource scan (playtest #3/#5,
// GDD §13). The scan tests resource candidates nearest-first, cheaply filtering
// those with NO standable neighbour (sealed deep pools / buried ore) BEFORE any
// pathfind; this caps how many of the survivors that DO have a standable bank
// we actually A* to before giving up this scan (re-tried next cooldown). Keeps
// reachable-target selection O(scan) + O(K·A*), never O(R²·A*) per tick.
export const REACH_MAX_PATH_ATTEMPTS = 24;

// Number of survivors spawned at the start of a game.
export const SURVIVOR_COUNT = 4;

// Spread radius (cells) around the home point used when positioning each
// survivor at spawn so they don't all stack on the same cell.
export const SURVIVOR_SPAWN_SPREAD = 12;

// Minimum ticks that must elapse between forced path recomputes for a survivor
// (GDD §13 navgrid — avoids repathing every tick on mutable terrain).
export const PATH_REPATH_COOLDOWN = 30;

// ---------------------------------------------------------------------------
// Phase 6 — Roles, resources & tools (GDD §6.2, §6.3, §9)
// ---------------------------------------------------------------------------

// Work durations in ticks — how long a survivor stands and works a target
// before it yields output (GDD §6.2 timed chop/mine/gather). At SIM_HZ=60 these
// are ~1.5 s / 2 s / 0.75 s — mining is slowest, gathering the quickest.
export const CHOP_TICKS = 90;
export const MINE_TICKS = 120;
export const GATHER_TICKS = 45;

// Wood-tier tool durability (GDD §6.3: wood is brittle). Number of work actions
// a fresh tool survives before it breaks and is discarded. MVP = wood tier only;
// iron/stone tiers and the upgrade path are vertical-slice (GDD §14).
export const WOOD_TOOL_DURABILITY = 5;

// Yield per completed work action (GDD §6.2 outputs → stockpile §8).
export const WOOD_PER_CHOP = 1;   // lumberjack: FOLIAGE → wood
export const STONE_PER_MINE = 1;  // miner: exposed STONE → stone
export const ORE_PER_MINE = 1;    // miner: exposed ORE → ore
export const FOOD_PER_GATHER = 1; // forager: FOLIAGE → food

// Auto-craft costs (GDD §6.2–6.3: a role is assignable only if its required
// wood-tier tool exists or can be crafted from the stockpile). Wood only — no
// workstation in MVP. Weapons are tools too (§6.3).
export const AXE_WOOD_COST = 2;
export const PICKAXE_WOOD_COST = 2;
export const WEAPON_WOOD_COST = 2;
export const BASKET_WOOD_COST = 1;

// ---------------------------------------------------------------------------
// Phase 6 UI — Assign tool & colony seed (GDD §6.2, p6-t5)
// ---------------------------------------------------------------------------

// Max distance (cells, Euclidean) from a pointer click to a survivor body
// anchor for the Assign tool to select that survivor.
export const ASSIGN_PICK_RADIUS = 10;

// Starting wood given to the colony at spawn so the first tool can be crafted.
export const STARTING_WOOD = 6;

// ---------------------------------------------------------------------------
// Phase 7 — zombies & combat (GDD §7)
// ---------------------------------------------------------------------------

// §7.1 — Zombie detection range: how close a survivor must be (cells, Chebyshev)
// before an idle zombie switches to pursuit mode.
export const SENSE_RADIUS = 60;

// §7.1 — Idle meander speed (cells/tick). Matches CRAWL_SPEED so an
// undirected zombie drifts slowly without telegraphing its threat.
export const ZOMBIE_IDLE_SPEED = 0.2;    // slow forward drift toward the colony (still < WALK_SPEED 0.3) — playtest: zombies must advance across the map, not shuffle in place

// §7.1 — Pursuit speed (cells/tick) once a zombie has detected a survivor.
// "slightly faster than WALK_SPEED (0.3)" — provides pressure without
// making the threat impossible to outrun while sprinting.
export const ZOMBIE_ATTACK_SPEED = 0.34;

// §7.1 — Idle retarget interval (ticks). When meandering, the zombie picks
// a new random wander goal after a random delay in this range, producing
// non-robotic, unpredictable movement.
export const ZOMBIE_IDLE_RETARGET_MIN = 60;
export const ZOMBIE_IDLE_RETARGET_MAX = 180;

// §7.1 — Idle meander radius (cells). The random idle goal column is chosen
// within this many cells of the zombie's CURRENT x, so an undirected zombie
// drifts locally rather than running off across the map. Kept small — the
// meander should read as aimless shuffling, not travel.
export const ZOMBIE_IDLE_RADIUS = 12;

// §7.2 — Melee adjacency reach (cells). Both zombie and survivor bodies can
// strike targets within this many cells of their anchor point.
export const ATTACK_REACH = 2;

// §7.2 — Ticks between successive melee strikes for any body (zombie or
// survivor). Prevents the same attacker landing hits every tick.
export const ATTACK_COOLDOWN = 45;

// §7.2 / §5.1 outcome 3 — Bite & turning. Probability that a single zombie BITE
// infects an un-infected survivor (the optional balance knob: "not every bite
// need infect"). 1.0 = every bite infects. Consumed by biteAttack (combat.ts) —
// this Math.random() lives in the BODY/AI layer, never inside the chunked CA.
export const TURN_FROM_BITE = 1.0;

// §7.2 — Ticks after a bite during which the infected survivor KEEPS ACTING
// before it drops to a prone/downed state. (Seeded for Task 4 progression; the
// bite itself only sets `infected` + `infectionTicks=0`.)
export const INFECTION_ACTING_TICKS = 120;

// §7.2 — Total ticks from bite to REANIMATION as a zombie (same body, controller
// swapped). Must exceed INFECTION_ACTING_TICKS (act, then lie prone, then turn).
// (Seeded for Task 4 progression; unused by the bite itself.)
export const TURN_DELAY_TICKS = 300;

// §7.2 — Radius (cells) from a guard's assigned hold point within which it
// will leave position to engage a zombie. Beyond this radius it returns home.
export const GUARD_ENGAGE_RADIUS = 40;

// NOTE — ATTACK_DAMAGE: the damage model is fully emergent (GDD §7.2).
// A successful strike releases body-region cells (flesh/bone/blood) into the
// sim — there is NO HP subtraction and NO HP bar. This constant is therefore
// intentionally absent; any per-hit output is determined by the
// damage→cells handoff logic (GDD §5.1 / §7.2, see expensive_coder scope).

// §7.4 — Breaching: per-tick probability that a single zombie blocked by
// a WOOD barrier chips 1 point of its integrity. Kept sub-0.2 so a lone
// zombie breaks through only after sustained contact (GDD §7.4).
export const BREACH_CHANCE = 0.18;

// §7.4 — Extra integrity-chip weight per ADDITIONAL zombie on the same cell
// (beyond the first). Represents crowd pressure: more bodies = faster breach.
export const BREACH_PRESSURE_MULT = 0.6;

// §7.1 — Single spawn edge for MVP (GDD §14 — dual-edge and herd dynamics
// are vertical-slice). Typed as a literal union so consumers get a
// narrowed string literal, not a plain string.
export const ZOMBIE_SPAWN_EDGE: 'left' | 'right' = 'left';

// §7.1 — Y cell row at which zombies appear, just above the main floor so
// they land immediately and begin walking without a long drop.
export const ZOMBIE_SPAWN_Y = P3_GROUND_Y - 1;

// §13 — Hard cap on simultaneously-active zombie entities (performance).
// Mobile budget (task 10-8): this is the concurrent-zombie ceiling enforced in
// waves.ts (aliveZombieCount < MAX_ZOMBIES gates every spawn). 24 chunky rigged
// bodies + their per-tick AI/locomotion is the mid-phone budget the playtest
// held; kept at 24 here (the gore cap below, not the zombie count, is the
// debris-accumulation risk on mobile). Tune down if a weaker target struggles.
export const MAX_ZOMBIES = 24;

// §13 — Mobile gore budget (task 10-8). Loose body-debris cells (FLESH/BONE/
// BLOOD shed by THE GATE — releaseBone/dissolveBody) otherwise accumulate
// forever as bodies fall apart, dragging the sim below framerate on a phone.
// A simple global CAP + slow FADE keeps the loose-debris count bounded WITHOUT
// full chunking (that is Phase 11). NOTE: terrain/structure cells are NEVER
// touched — only loose FLESH/BONE/BLOOD fades. See simulation.ts sweepGore().
//   MAX_GORE_CELLS: target ceiling for total loose FLESH/BONE/BLOOD cells. Under
//     this the sim runs untouched (gore still falls, piles, bleeds normally).
//   GORE_FADE_PER_TICK: when OVER budget, at most this many oldest/excess debris
//     cells are AIR-ified per tick — a slow fade (8/tick ≈ 480 cells/s @60Hz) so
//     gore lingers a few seconds, never snapping away, and the tick stays bounded.
//   GORE_RECOUNT_INTERVAL: ticks between full debris recounts. The count is the
//     only full-grid scan; doing it every Nth tick (not every tick) amortises it
//     to ~N_cells/INTERVAL reads/tick while keeping the cap responsive (~0.5s).
export const MAX_GORE_CELLS = 1500;
export const GORE_FADE_PER_TICK = 8;
export const GORE_RECOUNT_INTERVAL = 30;

// Phase 11 (task 11-3) — Gore age/settle trickle (GDD §13: "fade/settle gore
// over time so debris doesn't accumulate forever"). The Phase-10 cap+fade only
// thins debris when OVER MAX_GORE_CELLS; this adds a gentle age-based trickle so
// an OLD battlefield self-cleans for readability EVEN WHILE UNDER the cap.
//   GORE_SETTLE_TICKS: how long the loose-debris field must sit quiescent (under
//     the cap AND unchanged — no fresh gore arriving) before it counts as "old"
//     and the trickle begins. ~30 s @60Hz, so combat debris lingers long enough
//     to read, then gradually clears once the fighting moves on.
//   GORE_AGE_FADE_PER_TICK: max loose FLESH/BONE/BLOOD cells AIR-ified per tick
//     by the trickle once the field is old. Deliberately slower than
//     GORE_FADE_PER_TICK (the over-cap fade) — a gentle settle, not a snap.
// APPROXIMATION (documented): per-cell age is NOT tracked (no spare slot — FIRE
// already reuses the integrity slot). We approximate "old debris" with a single
// GLOBAL settle clock that advances only while the whole field is quiescent and
// resets the instant fresh gore arrives or the field is over budget. See
// simulation.ts sweepGore().
export const GORE_SETTLE_TICKS = 1800;
export const GORE_AGE_FADE_PER_TICK = 4;

// Phase 11 (task 11-3) — Body LOD (GDD §13: "LOD for distant/idle bodies"). A
// body that is BOTH far off-screen AND idle runs its controller only every Nth
// tick — it isn't doing anything the player can see, so missing a few movement
// ticks is invisible and cheap. Bodies that are on-screen, mid-fall, pursuing/
// attacking, being attacked, or self-preserving (seeking water/food / fleeing
// fire) are NEVER throttled — they update every tick so no combat, fall, or
// needs-death is ever missed. This is a GATE on WHEN the controller runs, never
// a change to locomotion.
//   BODY_LOD_OFFSCREEN_MARGIN: a body is "far" only when its (x,y) is more than
//     this many cells OUTSIDE the visible window (camera + viewport). The margin
//     keeps bodies just past the screen edge at full update so nothing pops as
//     it scrolls into view.
//   BODY_LOD_THROTTLE: a far+idle body's controller runs once every this many
//     ticks (keyed by tick + body index so idlers stagger, spreading the work).
export const BODY_LOD_OFFSCREEN_MARGIN = 64;
export const BODY_LOD_THROTTLE = 4;

// Wave sizing (GDD §7.1 / §13). Wave N (0-indexed) sends
//   WAVE_SIZE_START + WAVE_SIZE_GROWTH × N  zombies total.
export const WAVE_SIZE_START = 3;
export const WAVE_SIZE_GROWTH = 2;

// §7.1 — Ticks between successive waves.
export const WAVE_INTERVAL = 2400;  // ticks between waves (~40s @60Hz) — playtest: give the colony room to breathe between waves

// §7.1 — Ticks between individual zombie spawns within the same wave,
// so they trickle onto the map rather than teleporting in as a block.
export const ZOMBIE_SPAWN_STAGGER = 30;

// ---------------------------------------------------------------------------
// Phase 8 — Player building & fire-as-tool (GDD §8, §7.4)
// ---------------------------------------------------------------------------

// §8 — Player-placed STONE WALL integrity. Walls are "the real barrier":
// high integrity so breaching (§7.4 chips hasIntegrity cells) takes sustained
// pressure. Compare WOOD/fence at 60. Fits in the Uint8Array integrity slot.
export const WALL_INTEGRITY = 200;

// §8 — Fence is wood: cheap, low-integrity, flammable. The fence's integrity is
// already supplied by WOOD's baseIntegrity (WOOD_INTEGRITY) — this is an alias
// for call-site clarity only. Do NOT change WOOD's value to tune the fence.
export const FENCE_INTEGRITY = WOOD_INTEGRITY;

// §8 — Build costs, per placed cell. Typed as Partial<Record<ResourceKind,…>>
// so they drop straight into resources.canAfford/spend.
export const FENCE_COST: Partial<Record<ResourceKind, number>> = { wood: 1 };
export const WALL_COST: Partial<Record<ResourceKind, number>> = { stone: 1 };

// §8 — Starting stone stockpile so a wall is buildable on load (used by main
// in task 8-4).
export const STARTING_STONE = 40;

// ---------------------------------------------------------------------------
// Phase 9 — worldgen, waves, win/lose, UI (GDD §5.3/§11/§12)
// ---------------------------------------------------------------------------

// §11 — Number of fully-cleared waves the survivors must endure to reach the
// win screen. Every zombie in the wave must die before the counter increments.
export const WIN_WAVES = 5;

// §7.1 — Floor for the wave interval (ticks) as difficulty ramps up.
// The interval never drops below this regardless of wave number.
export const WAVE_INTERVAL_MIN = 1200; // floor as the interval decays per wave (~20s) — playtest: keep late waves from stacking

// §7.1 — Each wave shortens the pre-wave pause by this many ticks:
//   effectiveInterval = max(WAVE_INTERVAL - WAVE_INTERVAL_DECAY*(waveNumber-1), WAVE_INTERVAL_MIN)
export const WAVE_INTERVAL_DECAY = 100;

// §12.2 — Simulation ticks advanced per rendered frame for each speed-toggle
// step. Index 0 = normal (1×), 1 = fast (2×), 2 = faster (3×).
export const SIM_SPEEDS = [1, 2, 3] as const;

// -- Worldgen (deterministic) — GDD §5.3 ------------------------------------

// Seed used by the deterministic worldgen RNG so every run produces the same
// map (useful for testing; a future version may expose this to players).
export const WORLDGEN_SEED = 1337;

// Mean Y row of the surface (cells, increases downward). Matches the Phase-3
// test floor P3_GROUND_Y — worldgen keeps the same horizon.
export const SURFACE_BASE_Y = 140;

// Half-amplitude of the sinusoidal surface variation (± rows). Produces gentle
// rolling hills without extreme cliffs.
export const SURFACE_AMPLITUDE = 6;

// Thickness (rows) of the grass/soil DIRT band at the very surface.
export const SURFACE_SOIL_DEPTH = 4;

// Thickness (rows) of the DIRT band below the soil layer, before stone begins.
export const DIRT_DEPTH = 18;

// Per-column probability that a sand pocket is started in the dirt/stone zone.
export const SAND_POCKET_CHANCE = 0.04;

// Maximum radius (cells) of a generated sand pocket.
export const SAND_POCKET_MAX = 8;

// Per-cell probability that a stone cell seeds an ore vein during worldgen.
export const ORE_VEIN_DENSITY = 0.02;

// Length (cells) of each ore vein walk.
export const ORE_VEIN_LEN = 6;

// Depth below the local surface (rows) where water pools can form.
export const WATER_TABLE_DEPTH = 30;

// Per-column probability that a water pool is started at the water-table depth.
export const WATER_POOL_CHANCE = 0.012;

// Maximum half-width (cells) of a generated water pool.
export const WATER_POOL_MAX = 14;

// Number of woodland clusters scattered across the surface.
export const WOODLAND_CLUSTERS = 10;

// Width (cells) of each woodland cluster footprint.
export const WOODLAND_CLUSTER_W = 24;

// Height (cells) of tree foliage above the surface in a woodland cluster.
export const FOLIAGE_HEIGHT = 6;

// -- Spawn-zone guarantees — GDD §5.3 ---------------------------------------
// Survivors always start in a safe zone away from the zombie edge, with
// accessible wood and water within RESOURCE_SCAN_RADIUS.

// Minimum horizontal distance (cells) from the zombie spawn edge to the
// survivor starting area, keeping them out of the immediate danger zone.
export const SPAWN_ZONE_MARGIN = 360;

// Number of WOOD cells that must exist within RESOURCE_SCAN_RADIUS of the
// spawn zone; worldgen ensures this by seeding extra woodland if needed.
export const SPAWN_GUARANTEE_WOOD_CELLS = 60;

// Whether worldgen must guarantee at least one WATER cell reachable from the
// spawn zone (places a small pool if none exists within RESOURCE_SCAN_RADIUS).
export const SPAWN_GUARANTEE_WATER = true;

// Player ammo for the Shoot tool (playtest: limited bullets so you can't just
// shoot every zombie — GDD §6.3/§13 guns are a power spike gated by scarce ammo).
export const STARTING_AMMO = 15;

// ---------------------------------------------------------------------------
// Phase 10 task 10-6 — tap-cycle selection & right-click / long-press menu
// (GDD §12.3 long-press context menu, §12.4 forgiving tap selection)
// ---------------------------------------------------------------------------

// Generous pick radius (cells, Euclidean) used by long-press, right-click, and
// tap-cycle selection so players can tap near a survivor without pixel precision.
export const SELECT_TAP_RADIUS = 6;

// Max time (ms) between two taps at ~the same world position that are considered
// a "same-spot" repeated tap, causing the cycle to advance to the next survivor
// instead of resetting to the nearest. After this window the cycle resets.
export const TAP_CYCLE_RESET_MS = 800;

// ---------------------------------------------------------------------------
// Phase 11 task 11-5 — Survivor role tints (GDD §12 UX readability)
// Render-only: pixel colours are blended toward the role tint at draw time.
// NEVER mutates body matter or grid cells.
// ---------------------------------------------------------------------------

// Fraction (0–1) that each pixel is pulled toward the role's tint colour.
// 0 = no tint (original colour); 1 = fully replaced by tint.
export const ROLE_TINT_MIX = 0.45;

// ---------------------------------------------------------------------------
// Phase 11 (task 11-7) — Hit-flash juice (GDD §12 UX readability)
// A small time-bounded visual cue when a body takes damage. Drawn as a
// brief expanding ring at the hit world location via the ctx overlay layer
// (NEVER the ImageData path — the renderer's putImageData invariant is kept).
//
// HIT_FLASH_TICKS : how many sim ticks the ring expands before expiring.
// MAX_HIT_FLASHES : hard cap on simultaneous active flashes — old ones are
//   dropped when the cap is reached so the array NEVER grows unboundedly.
// SCREEN_SHAKE_PX : max pixel offset for optional screen shake on a big event
//   (death/dissolve). Kept ≤2 px and decaying so it is purely subliminal;
//   set to 0 to disable.
// ---------------------------------------------------------------------------
export const HIT_FLASH_TICKS = 18;
export const MAX_HIT_FLASHES = 24;
export const SCREEN_SHAKE_PX = 2;

// ---------------------------------------------------------------------------
// Revised death model (post-MVP) — corpses (GDD §5.1 "Quiet/needs → lie down as
// a corpse", §13 decay)
// ---------------------------------------------------------------------------

// A QUIET death (starvation, thirst, drowning, slow bleed-out) lays the rig down
// as a PRONE CORPSE BODY rather than dissolving it into cells (the EXTREME
// death). The corpse is inert and decays/fades over time.
//   CORPSE_DECAY_TICKS: ticks a fresh corpse persists before it has fully
//     decayed/faded (seeded into Body.corpseTicks on lay-down). At SIM_HZ=60
//     this is ~30 s — long enough to read on the battlefield, then it clears.
//   MAX_CORPSES: hard cap on simultaneously-tracked corpse bodies (perf/LOD);
//     the oldest are retired when the cap is exceeded (consumed by later tasks).
export const CORPSE_DECAY_TICKS = 1800;
export const MAX_CORPSES = 16;
// Render-only grey tint applied to corpse bodies (task 2 revised death model).
// RGB values produce a desaturated grey-blue that reads as "cold/dead" without
// being pure grey (which would clash with stone). Blended via ROLE_TINT_MIX.
export const CORPSE_TINT: [number, number, number] = [110, 110, 118];
