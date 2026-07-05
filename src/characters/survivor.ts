/**
 * characters/survivor.ts - Survivor controller: needs + autonomy (GDD 6.1).
 *
 * A Survivor WRAPS a hybrid Body (5.1) with a small autonomy layer: needs that
 * deplete over time and a behaviour that drives the body across the live terrain
 * by setting `body.moveDir`. This controller OWNS the body drive - main calls
 * updateSurvivor once per tick and never pokes moveDir itself.
 *
 * SCOPE: Hunger + Thirst + Warmth (Task W1 added warmth). Needs deplete faster
 * with exertion (moving) and, for thirst, near heat (FIRE). WARMTH instead
 * depletes under AMBIENT_COLD when NOT near a heat source (and not sheltered -
 * shelter is W2/W3, treated false here) and is RESTORED near FIRE within
 * FIRE_WARMTH_RADIUS (passive proximity - never a seek-fire behaviour, since
 * survivors FLEE fire; see FIRE_WARMTH_RADIUS invariant in config). When a need
 * hits 0 the survivor dies a QUIET death (layDownCorpse -> prone corpse, rig
 * intact), NOT the extreme cell-dissolve (revised death model, GDD 5.1).
 *
 * AUTO-OVERRIDE (p5-t4, GDD 6.1 / 13): crossing a need threshold DROPS wander
 * and self-preserves. Each tick we pick a behaviour by priority -
 *   fleeFire > seekWater(thirst) > seekFood(hunger) > seekWarmth(cold) > wander
 * - then drive the body toward the nearest resource via the coarse navgrid
 * router (game/pathfinding) plus LOCAL STEERING (set body.moveDir toward the
 * next waypoint's x; let Phase-3 locomotion do the actual walk/step/fall). Paths
 * are recomputed only when stale (a LOCAL terrain edit touched them) or missing,
 * throttled by PATH_REPATH_COOLDOWN. On arrival the survivor stands and consumes
 * (drink restores thirst; eat restores hunger AND consumes the FOLIAGE cell -
 * the MVP food source until the Phase-6 Forager). Because bodies COLLIDE with
 * FOLIAGE and can't stand in WATER, we always path to a standable cell ADJACENT
 * to the resource and never into it. DOM-free pure logic so it stays
 * headless-testable.
 */

import type { Body } from './body';
import { createBody } from './body';
import { updateBody } from './locomotion';
import { layDownCorpse } from './damage';
import type { Zombie } from './zombie';
import { launchArrow } from '../game/projectiles';
import { get, set } from '../engine/grid';
import { FIRE, CAMPFIRE, WATER, SNOW, FOLIAGE, AIR, WOOD, WALL, isFluid, isSolidForBody } from '../engine/materials';
import { markTerrainEdit } from '../engine/navgrid';
import { getWeather, getTemperature } from '../engine/weather';
import type { Path } from '../game/pathfinding';
import { findPath, isPathStale } from '../game/pathfinding';
import type { RoleName, Tool, ToolKind } from '../game/roles';
import {
  ROLES,
  isExposedRock,
  useTool,
  mineOutput,
  canAssign,
  craftToolFor,
} from '../game/roles';
import type { ResourceKind } from '../game/resources';
import { addResource, stockpilePoint, getStockpile, spend } from '../game/resources';
import type { Blueprint } from '../game/buildqueue';
import { getBlueprints, blueprintAt, removeBlueprint, reserve, release } from '../game/buildqueue';
import { placeStructure, canPlace, STRUCTURES } from '../game/building';
import { getShelterProject } from '../game/shelter';
import {
  NEED_MAX,
  WOOD_PER_CHOP,
  STONE_PER_MINE,
  ORE_PER_MINE,
  FOOD_PER_GATHER,
  HUNGER_RATE,
  THIRST_RATE,
  WARMTH_RATE,
  WARMTH_RESTORE_RATE,
  WARMTH_THRESHOLD,
  WETNESS_RATE,
  DRY_RATE,
  DRY_FIRE_MULT,
  WET_WARMTH_MULT,
  WARMTH_SAMPLE_TICKS,
  FIRE_WARMTH_BONUS,
  SHELTER_WARMTH_BONUS,
  SNOW_CONTACT_PENALTY,
  WARMTH_COLD_SPAN,
  WARMTH_COLD_FACTOR_MIN,
  WARMTH_COLD_FACTOR_MAX,
  COLD_THRESHOLD,
  TEMP_CLEAR,
  WEATHER_ENABLED,
  FIRE_WARMTH_RADIUS,
  EXERTION_RATE_MULT,
  HEAT_THIRST_MULT,
  HUNGER_THRESHOLD,
  THIRST_THRESHOLD,
  WANDER_RADIUS,
  WANDER_ARRIVE_DIST,
  WANDER_PAUSE_MIN,
  WANDER_PAUSE_MAX,
  WANDER_MAX_PURSUE_TICKS,
  EAT_RESTORE,
  DRINK_RESTORE,
  EAT_TICKS,
  DRINK_TICKS,
  CONSUME_REACH,
  RESOURCE_SCAN_RADIUS,
  REACH_MAX_PATH_ATTEMPTS,
  FLEE_FIRE_RADIUS,
  SHELTER_ROOF_SCAN,
  PATH_REPATH_COOLDOWN,
  GUARD_ENGAGE_RADIUS,
  ZOMBIE_FLEE_RADIUS,
  ARROW_COOLDOWN,
  ARROW_AIM_BODY_UP,
  ARROW_AIM_HEAD_UP,
  ARROW_MUZZLE_FWD,
  ARROW_MUZZLE_UP,
  WORLD_W,
  BODY_W,
  BODY_H,
  BUILDER_REACH_UP,
} from '../config';

/**
 * Autonomy behaviour. `wander` is the default idle drift; the auto-override
 * (GDD 6.1) switches to `seekWater`/`seekFood`/`fleeFire` on need/danger and to
 * `consuming` while drinking/eating in place.
 */
export type Behaviour =
  | 'wander'
  | 'seekWater'
  | 'seekFood'
  | 'seekWarmth'
  | 'fleeFire'
  | 'fleeZombie'
  | 'consuming';

/**
 * A survivor: a hybrid Body plus the needs/autonomy state that drives it.
 * `home` is the anchor the wander stays near; `path` holds the active navgrid
 * route (p5-t4).
 *
 * ROLE LOOP (p6-t4, GDD 6.2): an assigned `role` plus its `tool` drives a
 * find -> path -> work -> deposit -> repeat cycle (`roleState`) whenever no
 * need/fire auto-override is active. `workTarget` is the cell being harvested,
 * `workTicksLeft` counts down the timed work, and `carrying`/`carryKind` hold
 * the unit(s) headed for the stockpile. Tool durability decrements per work
 * action; a break drops the survivor back to idle (role 'none', tool null).
 */
export interface Survivor {
  body: Body;
  // Revised death model (GDD 5.1 outcome 3 / 7.2 turning): true once this
  // survivor's INFECTED body has reanimated as a zombie. The SAME Body is now
  // driven by a Zombie controller (reanimateAsZombie), so this controller must
  // stop driving it (updateSurvivor no-ops), it no longer counts as a living
  // survivor (state.ts), and it must not be re-targeted/re-bitten or rendered as
  // a survivor (main.ts). Lives on the controller because the hand-off is a
  // controller-swap concept; the Body stays alive===true throughout.
  turned: boolean;
  needs: { hunger: number; thirst: number; warmth: number };
  // Wetness in [0, NEED_MAX] (VS-2 Task T-A, GDD 6.1). NOT a killing need - kept
  // OUT of `needs` so the need-at-zero death loop never reads it. Rises in rain /
  // on WATER|SNOW contact, dries slowly (fast by a fire); a wet survivor loses
  // warmth faster (WET_WARMTH_MULT). 0 = dry, NEED_MAX = soaked.
  wetness: number;
  // Local effective-temperature sample cache (VS-2 Task T-B, GDD 6.1/10/13).
  // The composite effTemp + the spatial booleans it is built from are re-probed
  // only every WARMTH_SAMPLE_TICKS (perf) and reused between samples. effTemp
  // drives the warmth drain/refill; the booleans feed the wetness rules.
  //   lastWarmthSample : tick of the last sample (-1 = never sampled).
  //   smpEffTemp       : cached effective temperature (degC).
  //   smpWarm          : a heat source was within FIRE_WARMTH_RADIUS.
  //   smpSheltered     : standing under a roof.
  //   smpWetContact    : footprint touching WATER or SNOW.
  lastWarmthSample: number;
  smpEffTemp: number;
  smpWarm: boolean;
  smpSheltered: boolean;
  smpWetContact: boolean;
  home: { x: number; y: number };
  role: RoleName;
  behaviour: Behaviour;
  // Role-loop state (p6-t4). `tool` is the held wood-tier tool (null = idle).
  tool: Tool | null;
  carrying: number;
  carryKind: ResourceKind | null;
  roleState: 'toTarget' | 'working' | 'toStockpile';
  // Builder claim (BQ-3, GDD 6.2): the queued Blueprint this builder has
  // reserved and is walking to / working. null = no claim (the builder scans the
  // queue for the nearest claimable job). Persists across need-overrides so a
  // builder pulled away to drink resumes the same job on return.
  buildTarget: Blueprint | null;
  workTarget: { x: number; y: number } | null;
  // Standable cell the role loop walks to to harvest `workTarget` (within reach
  // of it). Acquired together with a REACHABLE target so the miner/forager never
  // fixate on an unreachable face/bush (playtest #3/#5).
  workStand: { x: number; y: number } | null;
  workTicksLeft: number;
  // Active navgrid route for a seek behaviour (null = none/blocked). Waypoints
  // are followed by local steering; `waypointIndex` is the next one to reach.
  path: Path | null;
  waypointIndex: number;
  deathCause: string | null;
  // Wander state: the current random goal column (null = pick a new one), how
  // many ticks we've chased it (give-up guard), and the remaining idle pause.
  wanderTarget: { x: number; y: number } | null;
  idleTicks: number;
  pauseTicks: number;
  // Autonomy/pathing bookkeeping (p5-t4):
  //   tick        : monotonic per-survivor tick counter (repath throttle clock).
  //   lastRepath  : tick of the last findPath call (gates PATH_REPATH_COOLDOWN).
  //   consumeTicks: ticks left standing still while drinking/eating.
  //   consumeKind : which need the in-progress consume restores.
  //   consumeCell : the FOLIAGE cell an eat will turn to AIR on completion.
  tick: number;
  lastRepath: number;
  consumeTicks: number;
  consumeKind: 'water' | 'food' | null;
  consumeCell: { x: number; y: number } | null;
  // The nearest-REACHABLE resource the active seekWater/seekFood is heading for
  // (resource cell + standable bank + route). Cached so the bounded reachable
  // scan + A* only runs on (re)acquire, not every tick (playtest #3, GDD 13).
  seekTarget: ReachTarget | null;
  // Ticks until the next melee strike is allowed (p7-t4, guard combat). Counts
  // down each updateSurvivor tick; only the guard combat branch ever arms it.
  attackCooldown: number;
  // Canonical id of this survivor's sight-group (VS-3 T5, GDD 6.2), stamped by
  // groups.ts on each recompute (-1 = ungrouped: dead/turned, or grouping not
  // wired - tests that never call updateGroups). seekWarmth uses it to find the
  // group's OWN shelter project (a known destination, not a scanned one).
  groupId: number;
}

/**
 * Create a survivor at feet-centre (x, y): body spawned there, both needs full,
 * home = spawn, role 'none', behaviour 'wander', no path/death yet.
 */
export function createSurvivor(x: number, y: number): Survivor {
  const body = createBody(x, y);
  // Survivors FLOAT (playtest v0.9 Q/O): head bobs above the waterline instead
  // of drowning under a rain/melt sheet. Zombies keep the sinking default.
  body.buoyant = true;
  return {
    body,
    turned: false,
    needs: { hunger: NEED_MAX, thirst: NEED_MAX, warmth: NEED_MAX },
    wetness: 0, // start bone dry (VS-2 Task T-A)
    // Warmth sample cache (VS-2 Task T-B): unsampled (-1) -> sampled on the first
    // updateSurvivor tick. Default to a warm temp so a survivor never reads as
    // "freezing" before its first probe.
    lastWarmthSample: -1,
    smpEffTemp: TEMP_CLEAR,
    smpWarm: false,
    smpSheltered: false,
    smpWetContact: false,
    home: { x, y },
    role: 'none',
    behaviour: 'wander',
    tool: null,
    carrying: 0,
    carryKind: null,
    roleState: 'toTarget',
    buildTarget: null,
    workTarget: null,
    workStand: null,
    workTicksLeft: 0,
    path: null,
    waypointIndex: 0,
    deathCause: null,
    wanderTarget: null,
    idleTicks: 0,
    pauseTicks: 0,
    tick: 0,
    // Negative so the very first seek repaths immediately (no cooldown wait).
    lastRepath: -PATH_REPATH_COOLDOWN,
    consumeTicks: 0,
    consumeKind: null,
    consumeCell: null,
    seekTarget: null,
    attackCooldown: 0,
    groupId: -1, // stamped by groups.ts once grouping runs (VS-3 T5)
  };
}

/**
 * Is any cell in/around the body's footprint FIRE? Cheap bounded probe (one box
 * scan with a 1-cell margin around the authored figure, early-exit on the first
 * flame) used to accelerate thirst near heat (GDD 6.1 "Thirst depletes from
 * time, heat"). The body anchor is the feet-centre, so the figure occupies
 * roughly dx in [-BODY_W/2, BODY_W/2], dy in [-(BODY_H-1), 0] above it.
 */
function nearFire(body: Body): boolean {
  const rx = Math.round(body.x);
  const ry = Math.round(body.y);
  const halfW = Math.ceil(BODY_W / 2) + 1;
  const x0 = rx - halfW;
  const x1 = rx + halfW;
  const y0 = ry - BODY_H; // one row above the head
  const y1 = ry + 1; // one row below the feet
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (get(x, y) === FIRE) return true;
    }
  }
  return false;
}

/**
 * Is any cell in/around the body's footprint WATER or SNOW? (VS-2 Task T-A, GDD
 * 6.1 wetness "on contact with WATER/SNOW".) Same cheap bounded box-scan as
 * nearFire, early-exiting on the first wet cell. Read-only over the live grid -
 * no autonomy or simulation change.
 */
function inWaterOrSnow(body: Body): boolean {
  const rx = Math.round(body.x);
  const ry = Math.round(body.y);
  const halfW = Math.ceil(BODY_W / 2) + 1;
  const x0 = rx - halfW;
  const x1 = rx + halfW;
  const y0 = ry - BODY_H; // one row above the head (catches rain pooling / drips)
  const y1 = ry + 1; // one row below the feet (standing in a puddle / snow)
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const m = get(x, y);
      if (m === WATER || m === SNOW) return true;
    }
  }
  return false;
}

/**
 * Is the body under a player-built ROOF? (Task W2, revised for the open-camp
 * shelter model - GDD 8 "enclosed space that provides warmth AND a retreat
 * point"). Cheap bounded probe over the live grid - read-only, no autonomy or
 * simulation change. Keys ONLY on WOOD and WALL (player structures), so natural
 * DIRT/STONE hillsides never count as shelter (MVP: built shelter only).
 *
 * ROOF-ONLY (the open-camp fix): shelter = a WOOD/WALL covering overhead, OPEN
 * SIDES. The old both-side-walls requirement sealed survivors into a box they
 * could not walk out of, so a warm colony died of THIRST (no path to water).
 * Dropping the side walls makes a roofed-but-open area count as shelter, so a
 * survivor warms under the canopy and freely walks IN/OUT for water and food.
 */
export function isSheltered(body: Body): boolean {
  return isShelteredAt(Math.round(body.x), Math.round(body.y));
}

/**
 * Shelter test for a HYPOTHETICAL body whose feet rest at (rx, ry) - the same
 * bounded WOOD/WALL ROOF probe as isSheltered, evaluated for a CANDIDATE stand
 * cell rather than the live body. W3's seekWarmth uses this to pick a sheltered
 * stand cell to retreat to (test the destination BEFORE walking there).
 *
 * Detection logic:
 *   - head row  = round(ry) - (BODY_H-1)   (top of the figure)
 *   - center col = round(rx)
 *   Roof: any of the SHELTER_ROOF_SCAN cells DIRECTLY ABOVE the head
 *         (headRow-1 ... headRow-SHELTER_ROOF_SCAN) is WOOD or WALL.
 *   Return: roof present (open sides - no wall requirement).
 *
 * Worst-case reads: SHELTER_ROOF_SCAN = 6 cells. Early-exits on first match.
 * NOTE the small clearance: the roof is detected even a few cells above the head
 * (so it reads as a roof, not a head-adjacent burial - burial-pin is a separate
 * locomotion concern at head-touching solids, handled by CAMP_ROOF_CLEARANCE).
 */
export function isShelteredAt(rx: number, ry: number): boolean {
  const headRow = ry - (BODY_H - 1);
  // Roof: scan upward from just above the head. WOOD/WALL only (open sides).
  for (let dy = 1; dy <= SHELTER_ROOF_SCAN; dy++) {
    const m = get(rx, headRow - dy);
    if (m === WOOD || m === WALL) return true;
  }
  return false;
}

/**
 * Is a heat source (FIRE or CAMPFIRE) within FIRE_WARMTH_RADIUS of the body
 * anchor? (Task W1 / VS-2 T-C, GDD 6.1/10/8 warmth restored near a heat source.)
 * A WIDER probe than nearFire (which is a tight footprint-adjacency test for
 * thirst-from-heat): warmth is PASSIVE PROXIMITY, and FIRE_WARMTH_RADIUS >=
 * FLEE_FIRE_RADIUS by invariant, so the ring a survivor is pushed back to when
 * fleeing fire still counts as warm. Counts CAMPFIRE too (VS-2 T-C): a managed
 * campfire warms without being fled (nearestFire/flee keys on FIRE only), so a
 * camp huddles by its hearth. Cheap bounded Chebyshev box scan, early-exit.
 */
function nearWarmth(body: Body): boolean {
  const rx = Math.round(body.x);
  const ry = Math.round(body.y);
  const R = FIRE_WARMTH_RADIUS;
  for (let dy = -R; dy <= R; dy++) {
    for (let dx = -R; dx <= R; dx++) {
      const m = get(rx + dx, ry + dy);
      if (m === FIRE || m === CAMPFIRE) return true;
    }
  }
  return false;
}

/**
 * Is a CAMPFIRE within FIRE_WARMTH_RADIUS of (rx, ry)? (VS-2 T-C.) CAMPFIRE-only
 * variant of nearWarmth used to validate a seekWarmth huddle target stand-cell:
 * a survivor deliberately retreats to a campfire (safe, contained) but NEVER to
 * raw FIRE (fleeFire owns flames), so this excludes FIRE. Cheap bounded box scan.
 */
function campfireNear(rx: number, ry: number): boolean {
  const R = FIRE_WARMTH_RADIUS;
  for (let dy = -R; dy <= R; dy++) {
    for (let dx = -R; dx <= R; dx++) {
      if (get(rx + dx, ry + dy) === CAMPFIRE) return true;
    }
  }
  return false;
}

/**
 * Local effective temperature at the body (VS-2 Task T-B, GDD 6.1/10): the
 * single scalar that drives the warmth need. Composes the global ambient temp
 * (VS-1 weather) with cheap LOCAL modifiers:
 *   + FIRE_WARMTH_BONUS    if a heat source is within FIRE_WARMTH_RADIUS
 *   + SHELTER_WARMTH_BONUS if under a roof (isSheltered)
 *   - SNOW_CONTACT_PENALTY if the footprint touches WATER or SNOW
 * Wetness is NOT folded in here - it stays the separate WET_WARMTH_MULT drain
 * multiplier (Task T-A) so the two are not double-counted. Pure read over the
 * live grid + globals; no RNG, no cell writes (chunk/replay-safe).
 *
 * NOTE: a single per-survivor scalar, sampled on an interval - NOT a per-cell
 * temperature grid (too expensive, GDD 13).
 */
export function effectiveTemp(body: Body): number {
  let t = getTemperature();
  if (nearWarmth(body)) t += FIRE_WARMTH_BONUS;
  if (isSheltered(body)) t += SHELTER_WARMTH_BONUS;
  if (inWaterOrSnow(body)) t -= SNOW_CONTACT_PENALTY;
  return t;
}

/**
 * Re-sample the warmth cache for survivor `s` (VS-2 Task T-B): re-probe the
 * spatial booleans and recompute the effective temperature, then stamp the
 * sample tick. Called only every WARMTH_SAMPLE_TICKS from the deplete loop, so
 * the ring/roof/contact scans run on an interval, not every tick (perf, GDD 13).
 */
function sampleWarmth(s: Survivor): void {
  const body = s.body;
  s.smpWarm = nearWarmth(body);
  s.smpSheltered = isSheltered(body);
  s.smpWetContact = inWaterOrSnow(body);
  let t = getTemperature();
  if (s.smpWarm) t += FIRE_WARMTH_BONUS;
  if (s.smpSheltered) t += SHELTER_WARMTH_BONUS;
  if (s.smpWetContact) t -= SNOW_CONTACT_PENALTY;
  s.smpEffTemp = t;
  s.lastWarmthSample = s.tick;
}

/** Inclusive random integer in [lo, hi]. */
function randInt(lo: number, hi: number): number {
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

/**
 * Wander behaviour (GDD 6.1 "idle/wander near base"): drift toward a random
 * goal column within WANDER_RADIUS of home by setting body.moveDir; pause on
 * arrival, then pick a new goal. Bounded so the survivor never strays beyond
 * WANDER_RADIUS of home. Sets moveDir; never touches the grid.
 */
function driveWander(s: Survivor): void {
  const body = s.body;

  // Idling on a pause between goals -> stand still and tick the pause down.
  if (s.pauseTicks > 0) {
    s.pauseTicks--;
    body.moveDir = 0;
    return;
  }

  // No active goal -> choose a random column within WANDER_RADIUS of home.
  if (s.wanderTarget === null) {
    const offset = randInt(-WANDER_RADIUS, WANDER_RADIUS);
    const gx = Math.min(WORLD_W - 1, Math.max(0, Math.round(s.home.x + offset)));
    s.wanderTarget = { x: gx, y: s.home.y };
    s.idleTicks = 0;
  }

  // Steer toward the goal column; arrive (or give up if stuck) -> pause + repick.
  const dx = s.wanderTarget.x - Math.round(body.x);
  const arrived = Math.abs(dx) <= WANDER_ARRIVE_DIST;
  const stuck = s.idleTicks >= WANDER_MAX_PURSUE_TICKS;
  if (arrived || stuck) {
    s.wanderTarget = null;
    s.idleTicks = 0;
    s.pauseTicks = randInt(WANDER_PAUSE_MIN, WANDER_PAUSE_MAX);
    body.moveDir = 0;
    return;
  }
  body.moveDir = dx > 0 ? 1 : -1;
  s.idleTicks++;
}

/**
 * Nearest FIRE cell within FLEE_FIRE_RADIUS of the body anchor, or null. Bounded
 * ring scan outward (closest ring first) so the flee steers away from the real
 * threat (GDD 6.1 flee fire). Cheap: at most a (2R+1)2 box, R = FLEE_FIRE_RADIUS.
 */
function nearestFire(body: Body): { x: number; y: number } | null {
  return nearestMaterial(
    Math.round(body.x),
    Math.round(body.y),
    FIRE,
    FLEE_FIRE_RADIUS,
  );
}

/**
 * Nearest cell of material `mat` within `maxR` (Chebyshev) of (cx, cy), or null.
 * Scans ring by ring outward and returns the Euclidean-closest hit in the FIRST
 * ring that contains one - a cheap "nearest resource" probe over the live grid
 * (GDD 13 local steering reads the world directly). Early-exits the instant a
 * ring yields a match so a nearby pool/bush costs only a few small rings.
 */
function nearestMaterial(
  cx: number,
  cy: number,
  mat: number,
  maxR: number,
): { x: number; y: number } | null {
  for (let r = 1; r <= maxR; r++) {
    let best: { x: number; y: number } | null = null;
    let bestD = Infinity;
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        // Perimeter of the box at radius r only (cells inside were scanned by a
        // smaller r already).
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = cx + dx;
        const y = cy + dy;
        if (get(x, y) === mat) {
          const d = dx * dx + dy * dy;
          if (d < bestD) {
            bestD = d;
            best = { x, y };
          }
        }
      }
    }
    if (best) return best;
  }
  return null;
}

/**
 * Is a cell of material `mat` within arm's reach of the body? Scans a small box
 * around the body footprint (+/-CONSUME_REACH horizontally, head-to-feet+1
 * vertically) and returns the nearest such cell, or null. This is the ARRIVAL
 * test: the survivor consumes a resource it can touch without overlapping it.
 * Bodies pass THROUGH foliage (permeable - GDD 5.2/9) and can't stand in WATER,
 * so reach/adjacency - never overlap - is the correct contact rule for harvest.
 */
function resourceWithinReach(
  body: Body,
  mat: number,
): { x: number; y: number } | null {
  const bx = Math.round(body.x);
  const by = Math.round(body.y);
  let best: { x: number; y: number } | null = null;
  let bestD = Infinity;
  for (let dy = -BODY_H; dy <= 1; dy++) {
    for (let dx = -CONSUME_REACH; dx <= CONSUME_REACH; dx++) {
      const x = bx + dx;
      const y = by + dy;
      if (get(x, y) === mat) {
        const d = dx * dx + dy * dy;
        if (d < bestD) {
          bestD = d;
          best = { x, y };
        }
      }
    }
  }
  return best;
}

/**
 * Is the specific cell (tx, ty) inside the body's reach box (same footprint as
 * resourceWithinReach: +/-CONSUME_REACH horizontally, head-to-feet+1 vertically)?
 * The role loop uses this for arrival at a KNOWN target cell (the foliage/rock
 * to harvest, or the stockpile point) rather than scanning for a material.
 * `up` widens the UPWARD reach only for the builder's construction placement
 * (BUILDER_REACH_UP - VS-3 geometry pass); every other caller keeps BODY_H.
 */
function cellWithinReach(body: Body, tx: number, ty: number, up: number = BODY_H): boolean {
  const dx = tx - Math.round(body.x);
  const dy = ty - Math.round(body.y);
  return dx >= -CONSUME_REACH && dx <= CONSUME_REACH && dy >= -up && dy <= 1;
}

/**
 * A resource the survivor can ACTUALLY use (playtest #3/#5, GDD 6.1/13): the
 * resource `cell`, a `standCell` (feet position) on solid ground within reach of
 * it, and a `path` there. The nearest-REACHABLE selection returns this triple
 * instead of the geometrically-nearest cell, so survivors skip resources with NO
 * standable neighbour (sealed deep-water pools, fully-buried ore) or NO route and
 * use the reachable spawn pond / surface foliage / exposed face instead.
 */
interface ReachTarget {
  cell: { x: number; y: number };
  standCell: { x: number; y: number };
  path: Path;
}

/**
 * Would a body whose feet rest at (fx, fy) have (rx, ry) inside its reach box?
 * Same footprint as resourceWithinReach/cellWithinReach (+/-CONSUME_REACH wide,
 * head-to-feet+1 tall) - the consume/harvest contact test, evaluated for a
 * CANDIDATE stand cell rather than the live body. `up` widens the upward reach
 * for builder construction only (BUILDER_REACH_UP).
 */
function reachBoxContains(
  fx: number,
  fy: number,
  rx: number,
  ry: number,
  up: number = BODY_H,
): boolean {
  const dx = rx - fx;
  const dy = ry - fy;
  return dx >= -CONSUME_REACH && dx <= CONSUME_REACH && dy >= -up && dy <= 1;
}

/**
 * Can a body stand with its feet at (x, fy)? The feet cell must be passable AND
 * non-fluid (never stand in water/blood), the cell directly below must be solid
 * ground, and the BODY_H cells above must be clear (headroom). This mirrors the
 * navgrid's standability but is evaluated at the FEET row, so a pass here lines
 * up with where the router/locomotion actually delivers the body. FOLIAGE is
 * permeable (non-solid), so a bush column is a valid place to stand.
 */
function isStandableFeet(x: number, fy: number): boolean {
  const here = get(x, fy);
  if (isSolidForBody(here)) return false; // feet space blocked by solid
  if (isFluid(here)) return false; // never stand in water/blood
  if (!isSolidForBody(get(x, fy + 1))) return false; // need a floor under the feet
  for (let h = 1; h < BODY_H; h++) {
    if (isSolidForBody(get(x, fy - h))) return false; // headroom for the figure
  }
  return true;
}

/**
 * Nearest cell a body can stand on to consume/harvest the resource at (rx, ry),
 * within reach of it - or null if it has NO standable neighbour (the sealed-pool
 * / buried-ore case the reachable selection must skip). Searches the reach box
 * around the resource, preferring the closest stand cell and, as a tiebreak, the
 * one on the body's side (bx) so the route is short. Cheap: a bounded box scan,
 * no pathfinding.
 */
function findStandCell(
  rx: number,
  ry: number,
  bx: number,
): { x: number; y: number } | null {
  let best: { x: number; y: number } | null = null;
  let bestScore = Infinity;
  const bodyDir = Math.sign(bx - rx);
  for (let fx = rx - CONSUME_REACH; fx <= rx + CONSUME_REACH; fx++) {
    for (let fy = ry - 1; fy <= ry + BODY_H; fy++) {
      if (!reachBoxContains(fx, fy, rx, ry)) continue;
      if (!isStandableFeet(fx, fy)) continue;
      const ddx = fx - rx;
      const ddy = fy - ry;
      const sideBias = Math.sign(ddx) === bodyDir ? 0 : 1;
      const score = ddx * ddx + ddy * ddy + sideBias;
      if (score < bestScore) {
        bestScore = score;
        best = { x: fx, y: fy };
      }
    }
  }
  return best;
}

/**
 * Nearest REACHABLE resource matching `match`, scanning rings outward from the
 * body anchor (nearest-first) and returning the first candidate that has BOTH a
 * standable neighbour AND a path to it (playtest #3/#5, GDD 6.1/13). The cheap
 * findStandCell filter runs first so we only A* to candidates with a real bank -
 * sealed pools / buried ore cost no pathfind. A* calls are capped at
 * REACH_MAX_PATH_ATTEMPTS per scan (the rest retried next cooldown) so this is
 * O(scan) + O(K.A*), never O(R2.A*). Returns null when nothing reachable is in
 * range (graceful degradation - the survivor wanders and may still die).
 */
function nearestReachable(
  s: Survivor,
  match: (x: number, y: number) => boolean,
): ReachTarget | null {
  const bx = Math.round(s.body.x);
  const by = Math.round(s.body.y);
  let attempts = 0;
  for (let r = 1; r <= RESOURCE_SCAN_RADIUS; r++) {
    // Collect this ring's matching cells, then test them nearest-first.
    const ring: Array<{ x: number; y: number; d: number }> = [];
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue; // perimeter only
        const x = bx + dx;
        const y = by + dy;
        if (match(x, y)) ring.push({ x, y, d: dx * dx + dy * dy });
      }
    }
    if (ring.length === 0) continue;
    ring.sort((a, b) => a.d - b.d);
    for (const c of ring) {
      const stand = findStandCell(c.x, c.y, bx);
      if (!stand) continue; // no standable bank -> skip (sealed pool / buried)
      if (attempts >= REACH_MAX_PATH_ATTEMPTS) return null; // give up this scan
      attempts++;
      const path = findPath(bx, by, stand.x, stand.y);
      if (path) return { cell: { x: c.x, y: c.y }, standCell: stand, path };
    }
  }
  return null;
}

/**
 * Nearest REACHABLE SHELTERED stand-cell within range (Task W3, GDD 6.1 "retreat
 * to shelter when too cold"). Scans rings outward from the body anchor
 * (nearest-first) for a cell where the feet can stand AND a body placed there
 * would be sheltered (isShelteredAt), then returns the first such cell with a
 * route to it. NEVER targets fire - fleeFire owns flames; seekWarmth is shelter
 * only (resolves the flee-vs-seek conflict). Mirrors nearestReachable's bounded
 * O(scan)+O(K.A*) shape: cheap standable+sheltered filter first, A* capped at
 * REACH_MAX_PATH_ATTEMPTS. Here the matched cell IS the stand cell (no separate
 * bank), so ReachTarget.cell === standCell. Returns null when no reachable
 * shelter is in range (-> the caller falls back to wander; W5's colony fire warms).
 */
function nearestReachableShelter(s: Survivor): ReachTarget | null {
  const bx = Math.round(s.body.x);
  const by = Math.round(s.body.y);
  let attempts = 0;
  for (let r = 1; r <= RESOURCE_SCAN_RADIUS; r++) {
    const ring: Array<{ x: number; y: number; d: number }> = [];
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue; // perimeter only
        const x = bx + dx;
        const y = by + dy;
        // A sheltered STAND cell: feet can rest here AND a body here is warm-safe.
        if (isStandableFeet(x, y) && isShelteredAt(x, y)) {
          ring.push({ x, y, d: dx * dx + dy * dy });
        }
      }
    }
    if (ring.length === 0) continue;
    ring.sort((a, b) => a.d - b.d);
    for (const c of ring) {
      if (attempts >= REACH_MAX_PATH_ATTEMPTS) return null; // give up this scan
      attempts++;
      const path = findPath(bx, by, c.x, c.y);
      if (path) {
        return { cell: { x: c.x, y: c.y }, standCell: { x: c.x, y: c.y }, path };
      }
    }
  }
  return null;
}

/**
 * The survivor's OWN GROUP's shelter as a warmth destination (VS-3 T5, GDD
 * 6.2/6.1 "the group retreats to ITS hut"). Unlike the generic ring scans below
 * this is a KNOWN location (the group's shelter project), not a discovered one -
 * it works from any distance the navgrid can route, so a straggler caught cold
 * out of sight of home still knows the way back while the split debounce holds
 * its membership. Only returns a target once the hut actually shelters
 * (isShelteredAt - i.e. the roof is on), and only for a standable interior cell
 * with a live route; candidates scan the interior feet row outward from the
 * representative interior cell so an occupied/campfire cell never blocks the
 * pick. Null when the survivor is ungrouped, the group has no project, or the
 * hut is unbuilt/unreachable - the caller falls back to the generic scans.
 */
function groupShelterTarget(s: Survivor): ReachTarget | null {
  const project = getShelterProject(s.groupId);
  if (!project) return null;
  const bx = Math.round(s.body.x);
  const by = Math.round(s.body.y);
  const fy = project.interior.y; // interior feet row
  const x0 = project.campfire.x; // leftmost interior column (leftWallX + 1)
  const x1 = x0 + project.iw - 1; // rightmost interior column
  // Candidate columns ordered nearest-to-representative first.
  const order: number[] = [project.interior.x];
  for (let d = 1; d <= x1 - x0; d++) {
    if (project.interior.x + d <= x1) order.push(project.interior.x + d);
    if (project.interior.x - d >= x0) order.push(project.interior.x - d);
  }
  for (const x of order) {
    if (!isStandableFeet(x, fy) || !isShelteredAt(x, fy)) continue;
    const path = findPath(bx, by, x, fy);
    if (path) return { cell: { x, y: fy }, standCell: { x, y: fy }, path };
  }
  return null;
}

/**
 * Nearest REACHABLE WARMTH destination (VS-2 T-C + VS-3 T5, GDD 6.1 "huddle by
 * a campfire OR step into a roofed shelter"). Preference order:
 *   1. The group's OWN shelter (groupShelterTarget) when built + reachable -
 *      even over a nearer foreign roof: the group huddles at ITS hearth (VS-3
 *      cohesion), and the hut is a known destination beyond scan range.
 *   2. Else the NEARER (by path length) of a reachable sheltered stand-cell
 *      (nearestReachableShelter) and a reachable standable BANK beside a
 *      CAMPFIRE (nearestReachable(CAMPFIRE), adjacent => within
 *      FIRE_WARMTH_RADIUS => warm).
 * All sub-scans are bounded + A*-capped + cooldown-throttled by the caller, so
 * this stays O(scan)+O(K.A*). Still NEVER targets raw FIRE. Returns null when no
 * home hut, shelter, or campfire is reachable (caller falls back to wander).
 */
function nearestReachableWarmth(s: Survivor): ReachTarget | null {
  const home = groupShelterTarget(s);
  if (home) return home;
  const shelter = nearestReachableShelter(s);
  const fire = nearestReachable(s, (x, y) => get(x, y) === CAMPFIRE);
  if (shelter === null) return fire;
  if (fire === null) return shelter;
  // Both reachable: prefer the shorter route (fewer waypoints ~ closer).
  return fire.path.waypoints.length < shelter.path.waypoints.length
    ? fire
    : shelter;
}

/**
 * Nearest REACHABLE work target for a harvest role (playtest #3/#5): exposed
 * STONE/ORE for the miner, FOLIAGE for the lumberjack/forager - each filtered to
 * one with a standable bank and a route, so the survivor walks to and works a
 * reachable face/bush instead of fixating on an unreachable nearest one.
 */
function reachableWorkTarget(s: Survivor, role: RoleName): ReachTarget | null {
  if (role === 'miner') {
    return nearestReachable(s, (x, y) => isExposedRock(x, y));
  }
  return nearestReachable(s, (x, y) => get(x, y) === FOLIAGE);
}

/**
 * Local steering toward a goal cell (p5-t4 pattern, shared by seek + role loop):
 * (re)plan a navgrid route when missing or LOCALLY stale (throttled by
 * PATH_REPATH_COOLDOWN), then set body.moveDir toward the next waypoint's x,
 * advancing waypoints within ~1 cell. With no usable path, steer straight at
 * `fallbackX` as a best-effort. The caller decides the goal (a STANDABLE cell
 * adjacent to a resource, or the stockpile point) - we never path into a target.
 */
function steerToCell(
  s: Survivor,
  goalX: number,
  goalY: number,
  fallbackX: number,
): void {
  const body = s.body;
  const bx = Math.round(body.x);
  const by = Math.round(body.y);
  const needPath = s.path === null || isPathStale(s.path);
  if (needPath && s.tick - s.lastRepath >= PATH_REPATH_COOLDOWN) {
    s.lastRepath = s.tick;
    s.path = findPath(bx, by, goalX, goalY);
    s.waypointIndex = 0;
  }
  if (s.path && s.path.waypoints.length > 0) {
    while (
      s.waypointIndex < s.path.waypoints.length &&
      Math.abs(bx - s.path.waypoints[s.waypointIndex].x) <= 1
    ) {
      s.waypointIndex++;
    }
    const target =
      s.waypointIndex < s.path.waypoints.length
        ? s.path.waypoints[s.waypointIndex].x
        : fallbackX;
    body.moveDir = target > bx ? 1 : target < bx ? -1 : 0;
  } else {
    body.moveDir = fallbackX > bx ? 1 : fallbackX < bx ? -1 : 0;
  }
}

/**
 * Seek a resource of material `mat` and, on arrival, switch to `consuming`
 * (GDD 6.1 self-preserve). Drive order each tick:
 *   1. ARRIVAL - a reachable resource cell -> stand still, enter `consuming`
 *      (record what to restore and, for food, which FOLIAGE cell to remove).
 *   2. TARGET - nearest resource cell; none in range -> fall back to wander.
 *   3. PATH - (re)plan to a STANDABLE cell ADJACENT to the resource (never into
 *      it) when missing or LOCALLY stale, throttled by PATH_REPATH_COOLDOWN.
 *   4. STEER - set body.moveDir toward the next waypoint's x (local steering);
 *      advance the waypoint within ~1 cell. No path (unreachable) -> steer
 *      straight at the resource as a best-effort fallback (may still die - that
 *      is the intended failure state).
 */
function driveSeek(
  s: Survivor,
  mat: number,
  kind: 'water' | 'food',
): void {
  const body = s.body;

  // 1. Arrival -> consume in place.
  const reach = resourceWithinReach(body, mat);
  if (reach) {
    s.behaviour = 'consuming';
    s.consumeTicks = kind === 'water' ? DRINK_TICKS : EAT_TICKS;
    s.consumeKind = kind;
    s.consumeCell = kind === 'food' ? reach : null;
    s.path = null;
    s.seekTarget = null;
    body.moveDir = 0;
    return;
  }

  // 2. (Re)acquire a nearest-REACHABLE target when we have none, it was consumed
  //    out from under us, or its route went locally stale. Throttled by the
  //    repath cooldown so the bounded reachable scan + A* never runs every tick
  //    (playtest #3, GDD 13). Skips sealed pools / unreachable bushes - picks
  //    the nearest resource with a standable bank we can actually path to.
  const t = s.seekTarget;
  const valid =
    t !== null &&
    get(t.cell.x, t.cell.y) === mat &&
    s.path !== null &&
    !isPathStale(s.path);
  if (!valid && s.tick - s.lastRepath >= PATH_REPATH_COOLDOWN) {
    s.lastRepath = s.tick;
    const next = nearestReachable(s, (x, y) => get(x, y) === mat);
    s.seekTarget = next;
    if (next) {
      s.path = next.path;
      s.waypointIndex = 0;
    } else {
      s.path = null;
    }
  }

  // 3. Nothing reachable in range. For FOOD there is one more larder to try
  //    (playtest v0.10 R "do survivors use the stored food?" - now they do):
  //    the COLONY STOCKPILE. Forager-gathered food is spent 1 unit per meal
  //    (atomic spend - two hungry survivors can't eat the same ration), eaten
  //    at the stockpile point via the normal consume flow (consumeCell null:
  //    a stockpile meal clears no bush). Wild foliage stays preferred (it is
  //    checked first, above); the stockpile is the fallback larder, so stored
  //    food is what carries the colony through winter/siege scarcity (GDD 8).
  //    Otherwise -> wander and keep depleting; genuine famine still kills.
  if (s.seekTarget === null) {
    if (kind === 'food' && getStockpile().food > 0) {
      if (cellWithinReach(body, stockpilePoint.x, stockpilePoint.y)) {
        if (spend({ food: 1 })) {
          s.behaviour = 'consuming';
          s.consumeTicks = EAT_TICKS;
          s.consumeKind = 'food';
          s.consumeCell = null; // stockpile ration - no cell to eat
          s.path = null;
          body.moveDir = 0;
          return;
        }
        // Another survivor took the last ration between the check and the
        // spend - fall through to wander and re-evaluate next pass.
      } else {
        steerToCell(s, stockpilePoint.x, stockpilePoint.y, stockpilePoint.x);
        return;
      }
    }
    driveWander(s);
    return;
  }

  // 4. Steer toward the STANDABLE bank beside the resource (never into it).
  const tgt = s.seekTarget;
  steerToCell(s, tgt.standCell.x, tgt.standCell.y, tgt.cell.x);
}

/**
 * Seek warmth = retreat to a HEARTH or SHELTER (Task W3 + VS-2 T-C, GDD 6.1
 * "huddle by a campfire OR step into a roofed shelter when too cold"). NEVER
 * seeks raw fire (fleeFire owns flames) - only a contained CAMPFIRE or a roof.
 * Drive order each tick:
 *   1. ARRIVAL - already warm (sheltered, or beside a fire/campfire => nearWarmth)
 *      -> stand still. Warmth then restores PASSIVELY via the deplete block; no
 *      `consuming` state needed.
 *   2. TARGET - (re)acquire the nearest REACHABLE warmth stand-cell (a sheltered
 *      cell, or a standable bank beside a campfire), throttled by
 *      PATH_REPATH_COOLDOWN like seek.
 *   3. NONE - no shelter and no campfire reachable -> fall back to wander (the
 *      survivor stays near home; a colony fire passively warms it). May still
 *      freeze if there is genuinely no heat anywhere - graceful degradation.
 *   4. STEER - local steering toward the warmth stand-cell.
 */
function driveSeekWarmth(s: Survivor): void {
  const body = s.body;

  // 1. Already warm (sheltered OR beside a campfire/fire) -> stand; warmth
  //    restores via the deplete block.
  if (isSheltered(body) || nearWarmth(body)) {
    s.path = null;
    s.seekTarget = null;
    body.moveDir = 0;
    return;
  }

  // 2. (Re)acquire a nearest-REACHABLE warmth stand-cell when we have none or its
  //    route went locally stale. A target stays valid while its stand-cell is
  //    still sheltered OR still beside a campfire. Throttled so the bounded scan
  //    + A* never runs every tick (GDD 13).
  const t = s.seekTarget;
  const valid =
    t !== null &&
    (isShelteredAt(t.standCell.x, t.standCell.y) ||
      campfireNear(t.standCell.x, t.standCell.y)) &&
    s.path !== null &&
    !isPathStale(s.path);
  if (!valid && s.tick - s.lastRepath >= PATH_REPATH_COOLDOWN) {
    s.lastRepath = s.tick;
    const next = nearestReachableWarmth(s);
    s.seekTarget = next;
    if (next) {
      s.path = next.path;
      s.waypointIndex = 0;
    } else {
      s.path = null;
    }
  }

  // 3. Nothing reachable -> wander near home (colony fire warms; may still die).
  if (s.seekTarget === null) {
    driveWander(s);
    return;
  }

  // 4. Steer toward the warmth stand-cell.
  const tgt = s.seekTarget;
  steerToCell(s, tgt.standCell.x, tgt.standCell.y, tgt.cell.x);
}

/**
 * Flee a threat (GDD 6.1): steer directly AWAY from a point (the nearest flame,
 * or the nearest zombie - playtest fix "survivors don't avoid the zombies") -
 * no path needed, just pick the horizontal direction that increases distance.
 * The caller only enters a flee behaviour with a threat present.
 */
function driveFleeFrom(s: Survivor, threat: { x: number; y: number }): void {
  const body = s.body;
  const dx = Math.round(body.x) - threat.x;
  body.moveDir = dx >= 0 ? 1 : -1; // threat to the left/under us -> go right, else left
}

/**
 * Consume in place (GDD 6.1): stand still for the consume duration, then restore
 * the need (clamped to NEED_MAX). Eating also CONSUMES the FOLIAGE cell (-> AIR)
 * and notifies the navgrid (markTerrainEdit) so any path over it goes stale;
 * drinking leaves the water be. When done, drop back to wander.
 */
function driveConsume(s: Survivor): void {
  s.body.moveDir = 0;
  if (s.consumeTicks > 0) {
    s.consumeTicks--;
    return;
  }
  if (s.consumeKind === 'water') {
    s.needs.thirst = Math.min(NEED_MAX, s.needs.thirst + DRINK_RESTORE);
  } else if (s.consumeKind === 'food') {
    s.needs.hunger = Math.min(NEED_MAX, s.needs.hunger + EAT_RESTORE);
    if (s.consumeCell) {
      set(s.consumeCell.x, s.consumeCell.y, AIR); // eat the bush
      markTerrainEdit(s.consumeCell.x, s.consumeCell.y); // navgrid: local edit
    }
  }
  // Reset consume state and return to idle wander.
  s.consumeKind = null;
  s.consumeCell = null;
  s.behaviour = 'wander';
  s.path = null;
}

/**
 * Assign (or clear) a survivor's role with tool gating (GDD 6.2). Returns true
 * on success, false if the role can't be afforded/crafted.
 *   - role 'none' -> always succeeds; keeps any held tool and resets the loop.
 *   - otherwise canAssign() gates on owned tool / craftable cost. If the
 *     survivor already holds the required tool kind we keep it; else we
 *     craftToolFor() (spends the stockpile). A failed craft -> false (unchanged).
 * On success the role/tool are set and the loop restarts at 'toTarget'.
 */
export function assignRole(s: Survivor, role: RoleName): boolean {
  // A reassigned/cleared builder hands its claimed blueprint back to the queue,
  // else the Blueprint stays reserved=true forever and no builder can re-claim it
  // (orphaned job). Death/turn bypass assignRole, so they release via
  // releaseBuildClaim() in updateSurvivor's dead/turned guards (VS-3 T3).
  if (s.buildTarget !== null) release(s.buildTarget);
  if (role === 'none') {
    s.role = 'none';
    s.roleState = 'toTarget';
    s.buildTarget = null;
    s.workTarget = null;
    s.workStand = null;
    s.workTicksLeft = 0;
    s.path = null;
    return true;
  }
  const owned: ToolKind[] = s.tool ? [s.tool.kind] : [];
  if (!canAssign(role, owned)) return false;
  const required = ROLES[role].requiredTool;
  // Keep a matching held tool; otherwise auto-craft from the stockpile.
  let tool = s.tool;
  if (required !== null && (tool === null || tool.kind !== required)) {
    tool = craftToolFor(role);
    if (tool === null) return false; // canAssign said yes but spend failed
  }
  s.role = role;
  s.tool = tool;
  s.roleState = 'toTarget';
  s.buildTarget = null;
  s.workTarget = null;
  s.workStand = null;
  s.workTicksLeft = 0;
  s.path = null;
  return true;
}

/**
 * Nearest ALIVE zombie within `maxR` (Euclidean) of (cx, cy), or null. Cheap
 * squared-distance scan over the zombies list (no sqrt) - the guard's target
 * picker (GDD 7.2). Dead/dissolved zombies are skipped (their cells belong to
 * the sim now).
 */
function nearestZombie(
  cx: number,
  cy: number,
  zombies: Zombie[],
  maxR: number,
): Zombie | null {
  const r2 = maxR * maxR;
  let best: Zombie | null = null;
  let bestD = Infinity;
  for (const z of zombies) {
    if (!z.body.alive) continue;
    const dx = z.body.x - cx;
    const dy = z.body.y - cy;
    const d = dx * dx + dy * dy;
    if (d <= r2 && d < bestD) {
      bestD = d;
      best = z;
    }
  }
  return best;
}

/**
 * Guard combat (GDD 7.2 / 6.2): an armed guard is an ARCHER, not a brawler. It
 * holds its assigned defensive point (the stockpile) and, whenever an ALIVE
 * zombie is within GUARD_ENGAGE_RADIUS, looses a VISIBLE ARROW that flies a
 * gravity ARC and wounds whatever body region it lands on (launchArrow ->
 * updateArrows -> THE GATE). It never closes to melee - it volleys from range as
 * the horde advances. The AIM only nudges where the shaft is sent: a crawler
 * (already down a leg) gets a finishing head shot; everything else a torso-mass
 * shot. WHICH region is actually wounded is decided by the arrow's true impact
 * cell, so a shot at an advancing zombie naturally scatters across head/torso/
 * legs (GDD 7.2 "body region specific damage depending on where they hit").
 * Only called when the role is 'guard' and a weapon (the bow) is held.
 */
function driveGuardCombat(s: Survivor, zombies: Zombie[]): void {
  const body = s.body;
  const bx = Math.round(body.x);
  const by = Math.round(body.y);

  // Hold the defensive point: an archer volleys in place, it does NOT chase.
  if (cellWithinReach(body, stockpilePoint.x, stockpilePoint.y)) {
    body.moveDir = 0;
  } else {
    steerToCell(s, stockpilePoint.x, stockpilePoint.y, stockpilePoint.x);
  }

  const z = nearestZombie(bx, by, zombies, GUARD_ENGAGE_RADIUS);
  if (z === null) return; // nothing in range -> just hold the line

  // Turn to face the target so the volley reads as aimed (locomotion keeps
  // facing while moveDir is 0). facing is +1 (right) / -1 (left).
  body.facing = z.body.x >= body.x ? 1 : -1;

  // Loose an arrow on the bow's cadence. Nock it at shoulder height, forward of
  // the guard's bow hand; aim at the target's torso mass, or its head to finish
  // a crawler. The arc + the horde's advance do the rest (impact picks region).
  if (s.attackCooldown <= 0) {
    const crawling = z.body.lLegLost || z.body.rLegLost;
    const sx = body.x + body.facing * ARROW_MUZZLE_FWD;
    const sy = body.y - ARROW_MUZZLE_UP;
    const tx = z.body.x;
    const ty = z.body.y - (crawling ? ARROW_AIM_HEAD_UP : ARROW_AIM_BODY_UP);
    launchArrow(sx, sy, tx, ty);
    s.attackCooldown = ARROW_COOLDOWN;
  }
}

/**
 * Run one tick of the role loop (GDD 6.2): find -> path -> work -> deposit ->
 * repeat. Only called when no need/fire override is active, role !== 'none' and
 * a tool is held. Sets body.moveDir (locomotion does the walk); harvests edit
 * the live grid + navgrid; tool durability decrements per work action and a
 * break drops the survivor to idle (role 'none', tool null).
 */
function driveRole(s: Survivor, zombies: Zombie[]): void {
  const body = s.body;
  const role = s.role;

  // Guard (GDD 6.2 / 7.2): an armed guard engages the nearest zombie in range
  // (LEG then HEADSHOT); with none in range it holds the stockpile point. Other
  // survivors never reach this branch.
  if (role === 'guard') {
    if (s.tool !== null && s.tool.kind === 'weapon') {
      driveGuardCombat(s, zombies);
    } else if (cellWithinReach(body, stockpilePoint.x, stockpilePoint.y)) {
      body.moveDir = 0;
    } else {
      steerToCell(s, stockpilePoint.x, stockpilePoint.y, stockpilePoint.x);
    }
    return;
  }

  // Builder (GDD 6.2 / 8, BQ-3): a queue-driven role, NOT a harvest role - it
  // claims a player blueprint, walks to it, builds it (BUILD_TICKS), then calls
  // placeStructure() to actualise the cell (atomic stockpile spend). Branch out
  // before the harvest switch (which only knows lumberjack/forager/miner and
  // would spin harvesting nothing for a builder).
  if (role === 'builder') {
    driveBuilder(s);
    return;
  }

  switch (s.roleState) {
    // 1. TO TARGET: acquire a work target, path to a cell ADJACENT to it, and
    //    enter 'working' once it's within reach (bodies pass through foliage but
    //    we still stop beside the cell, never inside, as the harvest contact).
    case 'toTarget': {
      if (s.workTarget === null) {
        // Acquire a nearest-REACHABLE target (standable bank + route), so the
        // miner/forager never fixate on an unreachable face/bush (playtest
        // #3/#5). Reuse the path the reachable scan already computed.
        const rt = reachableWorkTarget(s, role);
        if (rt === null) {
          driveWander(s); // nothing reachable in range -> idle drift this tick
          return;
        }
        s.workTarget = rt.cell;
        s.workStand = rt.standCell;
        s.path = rt.path;
        s.waypointIndex = 0;
      }
      const t = s.workTarget;
      if (cellWithinReach(body, t.x, t.y)) {
        s.roleState = 'working';
        s.workTicksLeft = ROLES[role].workTicks;
        s.path = null;
        body.moveDir = 0;
        return;
      }
      // Steer to the standable bank beside the target (within reach of it).
      const stand = s.workStand;
      if (stand) {
        steerToCell(s, stand.x, stand.y, t.x);
      } else {
        const side = Math.round(body.x) <= t.x ? -1 : 1;
        steerToCell(s, t.x + side, t.y, t.x);
      }
      return;
    }

    // 2. WORKING: stand still and count down. If an override (e.g. drinking)
    //    pulled us off the target, revert to 'toTarget' to walk back. On reaching
    //    0, harvest the cell, spend one tool use, and head for the stockpile.
    case 'working': {
      body.moveDir = 0;
      const t = s.workTarget;
      if (t === null || !cellWithinReach(body, t.x, t.y)) {
        s.roleState = 'toTarget';
        driveRole(s, zombies);
        return;
      }
      if (s.workTicksLeft > 0) {
        s.workTicksLeft--;
        return;
      }
      const m = get(t.x, t.y);
      let harvested = false;
      if (role === 'lumberjack' && m === FOLIAGE) {
        set(t.x, t.y, AIR); // GDD 9: chop the tree -> AIR
        markTerrainEdit(t.x, t.y);
        s.carrying += WOOD_PER_CHOP;
        s.carryKind = 'wood';
        harvested = true;
      } else if (role === 'forager' && m === FOLIAGE) {
        set(t.x, t.y, AIR); // GDD 9: gather the bush -> AIR
        markTerrainEdit(t.x, t.y);
        s.carrying += FOOD_PER_GATHER;
        s.carryKind = 'food';
        harvested = true;
      } else if (role === 'miner') {
        const out = mineOutput(m); // STONE->stone, ORE->ore (GDD 6.2)
        if (out !== null) {
          set(t.x, t.y, AIR);
          markTerrainEdit(t.x, t.y);
          s.carrying += out === 'ore' ? ORE_PER_MINE : STONE_PER_MINE;
          s.carryKind = out;
          harvested = true;
        }
      }
      s.workTarget = null;
      s.workStand = null;
      s.path = null;
      if (!harvested) {
        // Target changed under us (burned/edited) - don't waste durability; re-find.
        s.roleState = 'toTarget';
        return;
      }
      // GDD 6.3: the breaking use STILL did its work above - then discard.
      if (useTool(s.tool!)) {
        console.log(`Tool broke: ${role} axe/tool - returning to idle`);
        s.tool = null;
        s.role = 'none';
        s.roleState = 'toTarget';
        // Still carrying the just-harvested unit; deposit on a later assignment.
        return;
      }
      s.roleState = 'toStockpile';
      return;
    }

    // 3. TO STOCKPILE: path to the deposit point; on arrival drop the carry into
    //    the global stockpile (GDD 8) and loop back to find the next target.
    case 'toStockpile': {
      if (cellWithinReach(body, stockpilePoint.x, stockpilePoint.y)) {
        if (s.carryKind !== null && s.carrying > 0) {
          addResource(s.carryKind, s.carrying);
        }
        s.carrying = 0;
        s.carryKind = null;
        s.roleState = 'toTarget';
        s.path = null;
        body.moveDir = 0;
        return;
      }
      steerToCell(s, stockpilePoint.x, stockpilePoint.y, stockpilePoint.x);
      return;
    }
  }
}

/**
 * Nearest REACHABLE, CLAIMABLE blueprint for a builder (BQ-3, GDD 6.2/8).
 * The queue is a small overlay list (not a grid), so we scan it directly rather
 * than ring-by-ring: filter to jobs that are (a) unreserved, (b) still pending
 * (the cell doesn't already hold the target material), and (c) affordable RIGHT
 * NOW (canPlace) - a builder never claims a job the colony can't pay for, so it
 * can't deadlock walking to an unbuildable cell. Then, nearest-first, return the
 * first job with a standable bank (findStandCell, same footprint as harvesting)
 * AND a route to it. A* calls are capped at REACH_MAX_PATH_ATTEMPTS like the
 * harvest scan. Returns null when nothing is claimable/reachable (-> wander).
 */
function reachableBlueprint(
  s: Survivor,
): { bp: Blueprint; standCell: { x: number; y: number }; path: Path } | null {
  const bx = Math.round(s.body.x);
  const by = Math.round(s.body.y);
  const cands = getBlueprints()
    .filter(
      bp =>
        !bp.reserved &&
        get(bp.x, bp.y) !== STRUCTURES[bp.kind].material &&
        canPlace(bp.kind),
    )
    .map(bp => ({ bp, d: (bp.x - bx) * (bp.x - bx) + (bp.y - by) * (bp.y - by) }))
    .sort((a, b) => a.d - b.d);
  let attempts = 0;
  for (const { bp } of cands) {
    // Construction reach (BUILDER_REACH_UP > BODY_H): a builder places high wall
    // courses and roof-centre cells from the ground below (VS-3 geometry pass).
    // Stands are tried best-first WITH a route check each - the best stand can
    // be an unroutable wall-top; falling back to a ground stand instead of
    // skipping the cell is what lets the hut's upper courses ever get built.
    for (const stand of findBuildStands(bp.x, bp.y, bx)) {
      if (attempts >= REACH_MAX_PATH_ATTEMPTS) return null; // give up this scan
      attempts++;
      const path = findPath(bx, by, stand.x, stand.y);
      if (path) return { bp, standCell: stand, path };
    }
  }
  return null;
}

/**
 * Builder stand-cell candidates for the blueprint cell (rx, ry), BEST-first
 * (VS-3 geometry pass). Two construction-specific differences from the single-
 * result harvest findStandCell:
 *   - the builder must NEVER stand IN the cell it is about to fill (placing
 *     solid into its own feet cell would entomb it) - that candidate scores 0
 *     and would otherwise always win once a wall stack rises under a blueprint;
 *   - ALL candidates are returned sorted by score, because the best stand can
 *     be a wall-top cell A* cannot route to (step-up max) - the caller falls
 *     back to the next-best (usually ground) stand instead of stalling the
 *     whole build (the T3 tall-hut stall).
 * Uses the taller BUILDER_REACH_UP box; harvest selection is untouched.
 */
function findBuildStands(
  rx: number,
  ry: number,
  bx: number,
): { x: number; y: number }[] {
  const out: { x: number; y: number; score: number }[] = [];
  const bodyDir = Math.sign(bx - rx);
  for (let fx = rx - CONSUME_REACH; fx <= rx + CONSUME_REACH; fx++) {
    for (let fy = ry - 1; fy <= ry + BUILDER_REACH_UP; fy++) {
      if (fx === rx && fy === ry) continue; // never stand in the build cell
      if (!reachBoxContains(fx, fy, rx, ry, BUILDER_REACH_UP)) continue;
      if (!isStandableFeet(fx, fy)) continue;
      const ddx = fx - rx;
      const ddy = fy - ry;
      const sideBias = Math.sign(ddx) === bodyDir ? 0 : 1;
      out.push({ x: fx, y: fy, score: ddx * ddx + ddy * ddy + sideBias });
    }
  }
  out.sort((a, b) => a.score - b.score);
  return out.map(({ x, y }) => ({ x, y }));
}

/**
 * True iff the builder's claimed blueprint is no longer a valid job: it was
 * cancelled (removed from the queue, so blueprintAt no longer returns THIS
 * object) or already built (the cell now holds the target material - e.g. the
 * player painted it, or another builder finished it). Either way the claim is
 * stale and the builder should drop it and re-scan.
 */
function buildTargetStale(bp: Blueprint): boolean {
  return (
    blueprintAt(bp.x, bp.y) !== bp || get(bp.x, bp.y) === STRUCTURES[bp.kind].material
  );
}

/** Drop the builder's current claim WITHOUT releasing (the job is gone). */
function clearBuildClaim(s: Survivor): void {
  s.buildTarget = null;
  s.workTarget = null;
  s.workStand = null;
  s.path = null;
}

/**
 * RELEASE the builder's claim back to the queue and drop the local handle (VS-3
 * T3, GDD 13). For death/turn, which bypass assignRole: a builder that dies or
 * reanimates while holding a reserved Blueprint would otherwise leave it
 * reserved=true forever (an orphaned, un-reclaimable job - the BQ-4 TODO). Called
 * once from the dead/turned guards; idempotent (no-op once buildTarget is null).
 */
function releaseBuildClaim(s: Survivor): void {
  if (s.buildTarget === null) return;
  release(s.buildTarget);
  s.buildTarget = null;
}

/**
 * Builder loop (BQ-3, GDD 6.2/8): the queue-driven sibling of driveRole's
 * harvest machine. Two states reusing roleState ('toStockpile' is never entered
 * - a builder spends FROM the stockpile, it doesn't deposit):
 *
 *   toTarget -> claim the nearest reachable blueprint (reserve it), walk to the
 *     standable bank beside it, enter 'working' once within reach. The claim
 *     PERSISTS across need-overrides (drink/eat pull the builder away; it walks
 *     back to the SAME job), and is dropped only when the job goes stale.
 *   working -> stand still, count down BUILD_TICKS, then placeStructure() to
 *     actualise the cell (atomic stockpile spend) and removeBlueprint(). Hammer
 *     wear (useTool) may break the tool -> idle. If the spend fails (raced
 *     unaffordable), release the claim and re-scan WITHOUT spending durability.
 */
function driveBuilder(s: Survivor): void {
  const body = s.body;
  switch (s.roleState) {
    case 'toTarget': {
      if (s.buildTarget === null) {
        const claim = reachableBlueprint(s);
        if (claim === null) {
          driveWander(s); // nothing claimable/reachable -> idle drift this tick
          return;
        }
        s.buildTarget = claim.bp;
        reserve(claim.bp);
        s.workTarget = { x: claim.bp.x, y: claim.bp.y };
        s.workStand = claim.standCell;
        s.path = claim.path;
        s.waypointIndex = 0;
      }
      const bp = s.buildTarget;
      // Cancelled / built out from under us while walking -> drop & re-scan.
      if (buildTargetStale(bp)) {
        clearBuildClaim(s);
        return;
      }
      const t = s.workTarget!;
      if (cellWithinReach(body, t.x, t.y, BUILDER_REACH_UP)) {
        s.roleState = 'working';
        s.workTicksLeft = ROLES['builder'].workTicks;
        s.path = null;
        body.moveDir = 0;
        return;
      }
      const stand = s.workStand;
      if (stand) {
        steerToCell(s, stand.x, stand.y, t.x);
      } else {
        const side = Math.round(body.x) <= t.x ? -1 : 1;
        steerToCell(s, t.x + side, t.y, t.x);
      }
      return;
    }

    case 'working': {
      body.moveDir = 0;
      const bp = s.buildTarget;
      const t = s.workTarget;
      // An override (drinking) pulled us off the job -> walk back to the SAME bp.
      if (bp === null || t === null || !cellWithinReach(body, t.x, t.y, BUILDER_REACH_UP)) {
        s.roleState = 'toTarget';
        driveBuilder(s);
        return;
      }
      // Job invalidated (cancelled / built) while we worked -> drop & re-scan.
      if (buildTargetStale(bp)) {
        clearBuildClaim(s);
        s.roleState = 'toTarget';
        return;
      }
      if (s.workTicksLeft > 0) {
        s.workTicksLeft--;
        return;
      }
      // Build complete - actualise the blueprint (atomic stockpile spend).
      if (!placeStructure(bp.x, bp.y, bp.kind)) {
        // Raced unaffordable (another build/place drained the stockpile since we
        // claimed): keep the blueprint, hand the claim back, re-scan next tick.
        // Don't burn hammer durability on a no-op placement.
        release(bp);
        clearBuildClaim(s);
        s.roleState = 'toTarget';
        return;
      }
      removeBlueprint(bp);
      clearBuildClaim(s);
      // GDD 6.3: the build consumed one hammer use; the breaking use still did
      // its work above - then discard the tool and drop to idle.
      if (useTool(s.tool!)) {
        console.log('Tool broke: builder hammer - returning to idle');
        s.tool = null;
        s.role = 'none';
        s.roleState = 'toTarget';
        return;
      }
      s.roleState = 'toTarget';
      return;
    }
  }
}

/**
 * Pick this tick's behaviour by priority (GDD 6.1 auto-override). Full priority
 * including the Phase-6 role loop is:
 *   fleeFire > fleeZombie > seekWater(thirst) > seekFood(hunger) >
 *   seekWarmth(cold) > role-loop > wander.
 * This picker resolves the need/danger layer; when it lands on 'wander',
 * updateSurvivor substitutes the role loop if a role + tool are present.
 * DANGER interrupts ANYTHING (incl. consuming): fire first, then a nearby
 * zombie (playtest fix "survivors don't avoid the zombies") - an unarmed
 * survivor steers away from the nearest ALIVE zombie within ZOMBIE_FLEE_RADIUS
 * rather than standing there getting bitten. ARMED GUARDS never flee (they
 * engage via the role loop). Otherwise an in-progress consume runs to
 * completion. Switching to a NEW behaviour drops any stale route so the next
 * seek replans fresh. Returns the point to flee FROM (fire or zombie) when a
 * flee behaviour is chosen, else null.
 */
function selectBehaviour(
  s: Survivor,
  zombies: Zombie[],
): { x: number; y: number } | null {
  const fire = nearestFire(s.body);
  // An armed guard holds the line (driveGuardCombat) instead of fleeing; every
  // other survivor avoids the horde. Skip the (bounded) zombie scan for guards.
  const isArmedGuard =
    s.role === 'guard' && s.tool !== null && s.tool.kind === 'weapon';
  const threat = isArmedGuard
    ? null
    : nearestZombie(
        Math.round(s.body.x),
        Math.round(s.body.y),
        zombies,
        ZOMBIE_FLEE_RADIUS,
      );
  let fleePoint: { x: number; y: number } | null = null;
  let next: Behaviour;
  if (fire) {
    next = 'fleeFire';
    fleePoint = fire;
  } else if (threat) {
    next = 'fleeZombie';
    fleePoint = { x: Math.round(threat.body.x), y: Math.round(threat.body.y) };
  } else if (s.behaviour === 'consuming') {
    next = 'consuming'; // stay until done
  } else if (s.needs.thirst < THIRST_THRESHOLD) {
    next = 'seekWater';
  } else if (s.needs.hunger < HUNGER_THRESHOLD) {
    next = 'seekFood';
  } else if (
    s.needs.warmth < WARMTH_THRESHOLD &&
    !nearWarmth(s.body) &&
    !isSheltered(s.body)
  ) {
    // Warmth is the LOWEST-priority need (TUNABLE ordering): freezing is the
    // SLOWEST of the three deaths (WARMTH_RATE < THIRST/HUNGER), so a survivor
    // that is BOTH cold and thirsty/hungry eats/drinks first (GDD 6.1). Don't
    // seek if already warming - near a fire (nearWarmth) or already sheltered.
    // seekWarmth targets SHELTER ONLY, never fire (fleeFire owns flames).
    next = 'seekWarmth';
  } else {
    next = 'wander';
  }
  if (next !== s.behaviour) {
    s.behaviour = next;
    s.path = null;
    s.waypointIndex = 0;
    s.seekTarget = null; // a new behaviour re-acquires its own reachable target
  }
  return fleePoint;
}

/**
 * Advance one survivor by one sim tick. OWNS the body drive: deplete needs ->
 * resolve death (Phase-4 handoff) -> pick a behaviour (sets moveDir) -> step the
 * body. Call once per tick from main.
 */
export function updateSurvivor(s: Survivor, zombies: Zombie[] = []): void {
  const body = s.body;

  // 1. Dead-survivor guard: a dissolved body's cells belong to the sim now.
  if (!body.alive) {
    releaseBuildClaim(s); // VS-3 T3: a builder that died holding a claim frees it
    return;
  }
  // 1a. Turned guard (GDD 7.2): the body has reanimated as a zombie and is now
  //     driven by a Zombie controller. This survivor controller must not touch
  //     it (no needs, no drive, no body step - the zombie owns updateBody now).
  if (s.turned) {
    releaseBuildClaim(s); // VS-3 T3: a turned builder frees its claim too
    return;
  }
  // 1b. Prone/downed guard (GDD 7.2): an infected body that has dropped to a
  //     downed state (pre-turn) acts no more - no needs-seek, no fight, no
  //     drive. It is still alive (the turn timer runs in updateInfection); we
  //     hold it still and let locomotion settle it (gravity/grounding only).
  //     MVP: no prone crawl (PRONE_CRAWL stays absent).
  if (body.prone) {
    body.moveDir = 0;
    updateBody(body);
    return;
  }
  s.tick++;
  // Melee cadence clock (p7-t4): only the guard combat branch ever arms it.
  if (s.attackCooldown > 0) s.attackCooldown--;

  // 2. Deplete needs (GDD 6.1). Exertion (moving) drains both faster; heat
  //    (FIRE nearby) drains thirst on top of that. "moving" reads the moveDir
  //    set last tick - a cheap, one-tick-lagged proxy for current exertion.
  const exertion = body.moveDir !== 0 ? EXERTION_RATE_MULT : 1;
  const heat = nearFire(body) ? HEAT_THIRST_MULT : 1;
  s.needs.hunger = Math.max(0, s.needs.hunger - HUNGER_RATE * exertion);
  s.needs.thirst = Math.max(0, s.needs.thirst - THIRST_RATE * exertion * heat);

  // 2a. Warmth (Task W1, GDD 6.1/10): under AMBIENT_COLD a survivor that is
  //     COLD & EXPOSED (no heat source within FIRE_WARMTH_RADIUS, not sheltered)
  //     loses warmth; otherwise (by a fire, or sheltered) it warms back up fast.
  //     Warmth is mainly cold-vs-heat - no exertion factor (you don't freeze
  //     faster by walking). W3 wires REAL shelter: a sheltered survivor (under a
  //     WOOD/WALL ROOF, OPEN sides) stops losing warmth and warms back up - and
  //     can still walk OUT from under the canopy for water/food (open-camp fix).
  //     T-B (GDD 6.1/10/13): the boolean cold-gate is replaced by a graded LOCAL
  //     effective temperature, re-sampled on an interval (the spatial probes -
  //     fire ring, roof, water/snow contact - only run every WARMTH_SAMPLE_TICKS;
  //     the cached value drives every tick in between).
  if (
    s.lastWarmthSample < 0 ||
    s.tick - s.lastWarmthSample >= WARMTH_SAMPLE_TICKS
  ) {
    sampleWarmth(s);
  }

  // 2b. Wetness (VS-2 Task T-A, GDD 6.1 "wet" half of cold-and-wet): rises in
  //     RAIN (unless under a roof) and on WATER/SNOW contact; dries slowly
  //     otherwise, FAST by a fire. Pure per-survivor float - touches no grid
  //     cell, so it is chunk- and replay-safe. Wetness does not kill; it makes
  //     the cold bite harder via wetMult below. Reads the sampled booleans.
  const wetSource =
    (getWeather() === 'rain' && !s.smpSheltered) || s.smpWetContact;
  if (wetSource) {
    s.wetness = Math.min(NEED_MAX, s.wetness + WETNESS_RATE);
  } else {
    const dryRate = s.smpWarm ? DRY_RATE * DRY_FIRE_MULT : DRY_RATE;
    s.wetness = Math.max(0, s.wetness - dryRate);
  }
  // Wet survivors lose warmth faster (WET_WARMTH_MULT). Linear in the wet
  // fraction: dry = 1x, soaked = WET_WARMTH_MULT x.
  const wetMult = 1 + (WET_WARMTH_MULT - 1) * (s.wetness / NEED_MAX);

  // 2c. Warmth (GDD 6.1/10): the sampled effective temperature drives it. Below
  //     COLD_THRESHOLD warmth DRAINS, faster the colder it is (coldFactor scales
  //     with how far below freezing, clamped); at/above it warmth RESTORES. The
  //     drain is amplified by wetMult (T-A). WEATHER_ENABLED gates it so the
  //     master switch off => never cold (mirrors the old isAmbientColdNow gate).
  if (WEATHER_ENABLED && s.smpEffTemp < COLD_THRESHOLD) {
    const coldFactor = Math.min(
      WARMTH_COLD_FACTOR_MAX,
      Math.max(
        WARMTH_COLD_FACTOR_MIN,
        (COLD_THRESHOLD - s.smpEffTemp) / WARMTH_COLD_SPAN,
      ),
    );
    s.needs.warmth = Math.max(
      0,
      s.needs.warmth - WARMTH_RATE * coldFactor * wetMult,
    );
  } else {
    s.needs.warmth = Math.min(NEED_MAX, s.needs.warmth + WARMTH_RESTORE_RATE);
  }

  // 3. Death (GDD 6.1 failure states): a need at 0 kills the survivor. This is
  //    a QUIET death - the rig LIES DOWN as a prone corpse (layDownCorpse),
  //    NOT the extreme cell-dissolve (revised death model, GDD 5.1: starvation
  //    / thirst -> "lies down dead (corpse)"). Log the cause (UI is Phase 9) and
  //    do NOT re-drive the corpse.
  if (s.needs.hunger <= 0) {
    s.deathCause = 'starvation';
  } else if (s.needs.thirst <= 0) {
    s.deathCause = 'thirst';
  } else if (s.needs.warmth <= 0) {
    // GDD 6.1 warmth failure -> FREEZE. Still a QUIET death: layDownCorpse
    // (below) lies the rig down as a corpse - never dissolveBody.
    s.deathCause = 'frozen';
  }
  if (s.deathCause !== null) {
    console.log(`Survivor died: ${s.deathCause}`);
    layDownCorpse(body, s.deathCause);
    return;
  }

  // 4. Auto-override (GDD 6.1): crossing a need threshold, fire, OR a nearby
  //    zombie drops wander and self-preserves. Select the behaviour, then drive
  //    it - each driver only ever sets body.moveDir (local steering); locomotion
  //    walks. `fleePoint` is the point to flee FROM for a flee behaviour.
  const fleePoint = selectBehaviour(s, zombies);
  switch (s.behaviour) {
    case 'fleeFire':
    case 'fleeZombie':
      // selectBehaviour only returns a flee behaviour when fleePoint is non-null.
      driveFleeFrom(s, fleePoint!);
      break;
    case 'seekWater':
      driveSeek(s, WATER, 'water');
      break;
    case 'seekFood':
      driveSeek(s, FOLIAGE, 'food');
      break;
    case 'seekWarmth':
      driveSeekWarmth(s);
      break;
    case 'consuming':
      driveConsume(s);
      break;
    case 'wander':
    default:
      // GDD 6.2 role loop: with a role + tool and no active override, work the
      // job instead of idling. Otherwise (idle/unequipped) just wander.
      if (s.role !== 'none' && s.tool !== null) {
        driveRole(s, zombies);
      } else {
        driveWander(s);
      }
      break;
  }

  // 5. Step the body with the freshly-set drive.
  updateBody(body);
}
