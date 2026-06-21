/**
 * characters/survivor.ts — Survivor controller: needs + autonomy (GDD §6.1).
 *
 * A Survivor WRAPS a hybrid Body (§5.1) with a small autonomy layer: needs that
 * deplete over time and a behaviour that drives the body across the live terrain
 * by setting `body.moveDir`. This controller OWNS the body drive — main calls
 * updateSurvivor once per tick and never pokes moveDir itself.
 *
 * SCOPE: Hunger + Thirst + Warmth (Task W1 added warmth). Needs deplete faster
 * with exertion (moving) and, for thirst, near heat (FIRE). WARMTH instead
 * depletes under AMBIENT_COLD when NOT near a heat source (and not sheltered —
 * shelter is W2/W3, treated false here) and is RESTORED near FIRE within
 * FIRE_WARMTH_RADIUS (passive proximity — never a seek-fire behaviour, since
 * survivors FLEE fire; see FIRE_WARMTH_RADIUS invariant in config). When a need
 * hits 0 the survivor dies a QUIET death (layDownCorpse → prone corpse, rig
 * intact), NOT the extreme cell-dissolve (revised death model, GDD §5.1).
 *
 * AUTO-OVERRIDE (p5-t4, GDD §6.1 / §13): crossing a need threshold DROPS wander
 * and self-preserves. Each tick we pick a behaviour by priority —
 *   fleeFire  > seekWater(thirst) > seekFood(hunger) > wander
 * — then drive the body toward the nearest resource via the coarse navgrid
 * router (game/pathfinding) plus LOCAL STEERING (set body.moveDir toward the
 * next waypoint's x; let Phase-3 locomotion do the actual walk/step/fall). Paths
 * are recomputed only when stale (a LOCAL terrain edit touched them) or missing,
 * throttled by PATH_REPATH_COOLDOWN. On arrival the survivor stands and consumes
 * (drink restores thirst; eat restores hunger AND consumes the FOLIAGE cell —
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
import { bodiesAdjacent, pickAttackRegion, meleeAttack } from '../game/combat';
import { get, set } from '../engine/grid';
import { FIRE, WATER, FOLIAGE, AIR, WOOD, WALL, isFluid, isSolidForBody } from '../engine/materials';
import { markTerrainEdit } from '../engine/navgrid';
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
import { addResource, stockpilePoint } from '../game/resources';
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
  FIRE_WARMTH_RADIUS,
  AMBIENT_COLD,
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
  SHELTER_SIDE_SCAN,
  PATH_REPATH_COOLDOWN,
  GUARD_ENGAGE_RADIUS,
  ATTACK_COOLDOWN,
  WORLD_W,
  BODY_W,
  BODY_H,
} from '../config';

/**
 * Autonomy behaviour. `wander` is the default idle drift; the auto-override
 * (GDD §6.1) switches to `seekWater`/`seekFood`/`fleeFire` on need/danger and to
 * `consuming` while drinking/eating in place.
 */
export type Behaviour =
  | 'wander'
  | 'seekWater'
  | 'seekFood'
  | 'fleeFire'
  | 'consuming';

/**
 * A survivor: a hybrid Body plus the needs/autonomy state that drives it.
 * `home` is the anchor the wander stays near; `path` holds the active navgrid
 * route (p5-t4).
 *
 * ROLE LOOP (p6-t4, GDD §6.2): an assigned `role` plus its `tool` drives a
 * find → path → work → deposit → repeat cycle (`roleState`) whenever no
 * need/fire auto-override is active. `workTarget` is the cell being harvested,
 * `workTicksLeft` counts down the timed work, and `carrying`/`carryKind` hold
 * the unit(s) headed for the stockpile. Tool durability decrements per work
 * action; a break drops the survivor back to idle (role 'none', tool null).
 */
export interface Survivor {
  body: Body;
  // Revised death model (GDD §5.1 outcome 3 / §7.2 turning): true once this
  // survivor's INFECTED body has reanimated as a zombie. The SAME Body is now
  // driven by a Zombie controller (reanimateAsZombie), so this controller must
  // stop driving it (updateSurvivor no-ops), it no longer counts as a living
  // survivor (state.ts), and it must not be re-targeted/re-bitten or rendered as
  // a survivor (main.ts). Lives on the controller because the hand-off is a
  // controller-swap concept; the Body stays alive===true throughout.
  turned: boolean;
  needs: { hunger: number; thirst: number; warmth: number };
  home: { x: number; y: number };
  role: RoleName;
  behaviour: Behaviour;
  // Role-loop state (p6-t4). `tool` is the held wood-tier tool (null = idle).
  tool: Tool | null;
  carrying: number;
  carryKind: ResourceKind | null;
  roleState: 'toTarget' | 'working' | 'toStockpile';
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
  // scan + A* only runs on (re)acquire, not every tick (playtest #3, GDD §13).
  seekTarget: ReachTarget | null;
  // Ticks until the next melee strike is allowed (p7-t4, guard combat). Counts
  // down each updateSurvivor tick; only the guard combat branch ever arms it.
  attackCooldown: number;
}

/**
 * Create a survivor at feet-centre (x, y): body spawned there, both needs full,
 * home = spawn, role 'none', behaviour 'wander', no path/death yet.
 */
export function createSurvivor(x: number, y: number): Survivor {
  return {
    body: createBody(x, y),
    turned: false,
    needs: { hunger: NEED_MAX, thirst: NEED_MAX, warmth: NEED_MAX },
    home: { x, y },
    role: 'none',
    behaviour: 'wander',
    tool: null,
    carrying: 0,
    carryKind: null,
    roleState: 'toTarget',
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
  };
}

/**
 * Is any cell in/around the body's footprint FIRE? Cheap bounded probe (one box
 * scan with a 1-cell margin around the authored figure, early-exit on the first
 * flame) used to accelerate thirst near heat (GDD §6.1 "Thirst depletes from
 * time, heat"). The body anchor is the feet-centre, so the figure occupies
 * roughly dx ∈ [-BODY_W/2, BODY_W/2], dy ∈ [-(BODY_H-1), 0] above it.
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
 * Is the body inside an enclosed/roofed PLAYER-BUILT shelter? (Task W2, GDD
 * §8 / §6.1). Cheap bounded probe over the live grid — read-only, no autonomy
 * or simulation change. Keys ONLY on WOOD and WALL (player structures), so
 * natural DIRT/STONE hillsides never count as shelter (MVP: built shelter only).
 *
 * Detection logic:
 *   - head row  = round(body.y) − (BODY_H−1)   (top of the figure)
 *   - mid row   = round(body.y) − ⌊Body_H/2⌋  (mid-torso, where walls are read)
 *   - center col = round(body.x)
 *   Roof:      any of the SHELTER_ROOF_SCAN cells directly above the head
 *              (headRow-1 … headRow-SHELTER_ROOF_SCAN) is WOOD or WALL.
 *   Left wall: any of the SHELTER_SIDE_SCAN cells left at mid-row is WOOD/WALL.
 *   Right wall: same, rightward.
 *   Return: roof && leftWall && rightWall.
 *
 * Worst-case reads: SHELTER_ROOF_SCAN + 2×SHELTER_SIDE_SCAN = 14 cells.
 * All scans early-exit on the first match, so the common hot-path is cheaper.
 */
export function isSheltered(body: Body): boolean {
  const rx = Math.round(body.x);
  const ry = Math.round(body.y);
  const headRow = ry - (BODY_H - 1);
  const midRow  = ry - Math.floor(BODY_H / 2);

  // Roof: scan upward from just above the head.
  let roof = false;
  for (let dy = 1; dy <= SHELTER_ROOF_SCAN; dy++) {
    const m = get(rx, headRow - dy);
    if (m === WOOD || m === WALL) { roof = true; break; }
  }
  if (!roof) return false;

  // Left wall: scan left at mid-torso row.
  let leftWall = false;
  for (let dx = 1; dx <= SHELTER_SIDE_SCAN; dx++) {
    const m = get(rx - dx, midRow);
    if (m === WOOD || m === WALL) { leftWall = true; break; }
  }
  if (!leftWall) return false;

  // Right wall: scan right at mid-torso row.
  for (let dx = 1; dx <= SHELTER_SIDE_SCAN; dx++) {
    const m = get(rx + dx, midRow);
    if (m === WOOD || m === WALL) return true;
  }
  return false;
}

/**
 * Is a FIRE cell within FIRE_WARMTH_RADIUS of the body anchor? (Task W1, GDD
 * §6.1/§10 warmth restored near a heat source.) A WIDER probe than nearFire
 * (which is a tight footprint-adjacency test for thirst-from-heat): warmth is
 * PASSIVE PROXIMITY, and FIRE_WARMTH_RADIUS ≥ FLEE_FIRE_RADIUS by invariant, so
 * the ring a survivor is pushed back to when fleeing fire still counts as warm.
 * Reuses the bounded ring-scan nearestMaterial probe over the live grid.
 */
function nearWarmth(body: Body): boolean {
  return (
    nearestMaterial(
      Math.round(body.x),
      Math.round(body.y),
      FIRE,
      FIRE_WARMTH_RADIUS,
    ) !== null
  );
}

/** Inclusive random integer in [lo, hi]. */
function randInt(lo: number, hi: number): number {
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

/**
 * Wander behaviour (GDD §6.1 "idle/wander near base"): drift toward a random
 * goal column within WANDER_RADIUS of home by setting body.moveDir; pause on
 * arrival, then pick a new goal. Bounded so the survivor never strays beyond
 * WANDER_RADIUS of home. Sets moveDir; never touches the grid.
 */
function driveWander(s: Survivor): void {
  const body = s.body;

  // Idling on a pause between goals → stand still and tick the pause down.
  if (s.pauseTicks > 0) {
    s.pauseTicks--;
    body.moveDir = 0;
    return;
  }

  // No active goal → choose a random column within WANDER_RADIUS of home.
  if (s.wanderTarget === null) {
    const offset = randInt(-WANDER_RADIUS, WANDER_RADIUS);
    const gx = Math.min(WORLD_W - 1, Math.max(0, Math.round(s.home.x + offset)));
    s.wanderTarget = { x: gx, y: s.home.y };
    s.idleTicks = 0;
  }

  // Steer toward the goal column; arrive (or give up if stuck) → pause + repick.
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
 * threat (GDD §6.1 flee fire). Cheap: at most a (2R+1)² box, R = FLEE_FIRE_RADIUS.
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
 * ring that contains one — a cheap "nearest resource" probe over the live grid
 * (GDD §13 local steering reads the world directly). Early-exits the instant a
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
 * around the body footprint (±CONSUME_REACH horizontally, head-to-feet+1
 * vertically) and returns the nearest such cell, or null. This is the ARRIVAL
 * test: the survivor consumes a resource it can touch without overlapping it.
 * Bodies pass THROUGH foliage (permeable — GDD §5.2/§9) and can't stand in WATER,
 * so reach/adjacency — never overlap — is the correct contact rule for harvest.
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
 * resourceWithinReach: ±CONSUME_REACH horizontally, head-to-feet+1 vertically)?
 * The role loop uses this for arrival at a KNOWN target cell (the foliage/rock
 * to harvest, or the stockpile point) rather than scanning for a material.
 */
function cellWithinReach(body: Body, tx: number, ty: number): boolean {
  const dx = tx - Math.round(body.x);
  const dy = ty - Math.round(body.y);
  return dx >= -CONSUME_REACH && dx <= CONSUME_REACH && dy >= -BODY_H && dy <= 1;
}

/**
 * A resource the survivor can ACTUALLY use (playtest #3/#5, GDD §6.1/§13): the
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
 * Same footprint as resourceWithinReach/cellWithinReach (±CONSUME_REACH wide,
 * head-to-feet+1 tall) — the consume/harvest contact test, evaluated for a
 * CANDIDATE stand cell rather than the live body.
 */
function reachBoxContains(fx: number, fy: number, rx: number, ry: number): boolean {
  const dx = rx - fx;
  const dy = ry - fy;
  return dx >= -CONSUME_REACH && dx <= CONSUME_REACH && dy >= -BODY_H && dy <= 1;
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
 * within reach of it — or null if it has NO standable neighbour (the sealed-pool
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
 * standable neighbour AND a path to it (playtest #3/#5, GDD §6.1/§13). The cheap
 * findStandCell filter runs first so we only A* to candidates with a real bank —
 * sealed pools / buried ore cost no pathfind. A* calls are capped at
 * REACH_MAX_PATH_ATTEMPTS per scan (the rest retried next cooldown) so this is
 * O(scan) + O(K·A*), never O(R²·A*). Returns null when nothing reachable is in
 * range (graceful degradation — the survivor wanders and may still die).
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
      if (!stand) continue; // no standable bank → skip (sealed pool / buried)
      if (attempts >= REACH_MAX_PATH_ATTEMPTS) return null; // give up this scan
      attempts++;
      const path = findPath(bx, by, stand.x, stand.y);
      if (path) return { cell: { x: c.x, y: c.y }, standCell: stand, path };
    }
  }
  return null;
}

/**
 * Nearest REACHABLE work target for a harvest role (playtest #3/#5): exposed
 * STONE/ORE for the miner, FOLIAGE for the lumberjack/forager — each filtered to
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
 * adjacent to a resource, or the stockpile point) — we never path into a target.
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
 * (GDD §6.1 self-preserve). Drive order each tick:
 *   1. ARRIVAL — a reachable resource cell → stand still, enter `consuming`
 *      (record what to restore and, for food, which FOLIAGE cell to remove).
 *   2. TARGET — nearest resource cell; none in range → fall back to wander.
 *   3. PATH — (re)plan to a STANDABLE cell ADJACENT to the resource (never into
 *      it) when missing or LOCALLY stale, throttled by PATH_REPATH_COOLDOWN.
 *   4. STEER — set body.moveDir toward the next waypoint's x (local steering);
 *      advance the waypoint within ~1 cell. No path (unreachable) → steer
 *      straight at the resource as a best-effort fallback (may still die — that
 *      is the intended failure state).
 */
function driveSeek(
  s: Survivor,
  mat: number,
  kind: 'water' | 'food',
): void {
  const body = s.body;

  // 1. Arrival → consume in place.
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
  //    (playtest #3, GDD §13). Skips sealed pools / unreachable bushes — picks
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

  // 3. Nothing reachable in range → wander (and keep depleting → may die). This
  //    is the intended failure state (no reachable water/food → death).
  if (s.seekTarget === null) {
    driveWander(s);
    return;
  }

  // 4. Steer toward the STANDABLE bank beside the resource (never into it).
  const tgt = s.seekTarget;
  steerToCell(s, tgt.standCell.x, tgt.standCell.y, tgt.cell.x);
}

/**
 * Flee fire (GDD §6.1): steer directly AWAY from the nearest flame — no path
 * needed, just pick the horizontal direction that increases distance. If the
 * fire is gone (caller only enters this with fire present) we stand still.
 */
function driveFleeFire(s: Survivor, fire: { x: number; y: number }): void {
  const body = s.body;
  const dx = Math.round(body.x) - fire.x;
  body.moveDir = dx >= 0 ? 1 : -1; // fire to the left/under us → go right, else left
}

/**
 * Consume in place (GDD §6.1): stand still for the consume duration, then restore
 * the need (clamped to NEED_MAX). Eating also CONSUMES the FOLIAGE cell (→ AIR)
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
 * Assign (or clear) a survivor's role with tool gating (GDD §6.2). Returns true
 * on success, false if the role can't be afforded/crafted.
 *   - role 'none' → always succeeds; keeps any held tool and resets the loop.
 *   - otherwise canAssign() gates on owned tool / craftable cost. If the
 *     survivor already holds the required tool kind we keep it; else we
 *     craftToolFor() (spends the stockpile). A failed craft → false (unchanged).
 * On success the role/tool are set and the loop restarts at 'toTarget'.
 */
export function assignRole(s: Survivor, role: RoleName): boolean {
  if (role === 'none') {
    s.role = 'none';
    s.roleState = 'toTarget';
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
  s.workTarget = null;
  s.workStand = null;
  s.workTicksLeft = 0;
  s.path = null;
  return true;
}

/**
 * Nearest ALIVE zombie within `maxR` (Euclidean) of (cx, cy), or null. Cheap
 * squared-distance scan over the zombies list (no sqrt) — the guard's target
 * picker (GDD §7.2). Dead/dissolved zombies are skipped (their cells belong to
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
 * Guard combat (p7-t4, GDD §7.2 / §6.2): an armed guard engages the nearest
 * ALIVE zombie within GUARD_ENGAGE_RADIUS — close the distance, then strike on
 * cooldown. The aim is the same emergent model both ways: LEG the front rank to
 * SLOW it (intact target → 'leg'), and HEADSHOT crawlers to FINISH them (target
 * already missing a leg → 'head'). No zombie in range → fall back to holding the
 * stockpile point. Only called when the role is 'guard' and a weapon is held.
 */
function driveGuardCombat(s: Survivor, zombies: Zombie[]): void {
  const body = s.body;
  const bx = Math.round(body.x);
  const by = Math.round(body.y);

  const z = nearestZombie(bx, by, zombies, GUARD_ENGAGE_RADIUS);

  // No target in range → hold the assigned point (the MVP guard default).
  if (z === null) {
    if (cellWithinReach(body, stockpilePoint.x, stockpilePoint.y)) {
      body.moveDir = 0;
    } else {
      steerToCell(s, stockpilePoint.x, stockpilePoint.y, stockpilePoint.x);
    }
    return;
  }

  // In range but out of reach → close the distance toward the zombie's cell.
  if (!bodiesAdjacent(body, z.body)) {
    s.path = null; // chasing a moving target: don't reuse a stale resource route
    steerToCell(s, Math.round(z.body.x), Math.round(z.body.y), Math.round(z.body.x));
    return;
  }

  // Adjacent → hold position and strike on cooldown. LEG an intact zombie to
  // slow the front rank; HEADSHOT a crawler (already lost a leg) to finish it.
  body.moveDir = 0;
  if (s.attackCooldown <= 0) {
    const crawling = z.body.lLegLost || z.body.rLegLost;
    const aim = crawling ? 'head' : 'leg';
    const region = pickAttackRegion(z.body, aim);
    if (region) meleeAttack(z.body, region);
    s.attackCooldown = ATTACK_COOLDOWN;
  }
}

/**
 * Run one tick of the role loop (GDD §6.2): find → path → work → deposit →
 * repeat. Only called when no need/fire override is active, role !== 'none' and
 * a tool is held. Sets body.moveDir (locomotion does the walk); harvests edit
 * the live grid + navgrid; tool durability decrements per work action and a
 * break drops the survivor to idle (role 'none', tool null).
 */
function driveRole(s: Survivor, zombies: Zombie[]): void {
  const body = s.body;
  const role = s.role;

  // Guard (GDD §6.2 / §7.2): an armed guard engages the nearest zombie in range
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
          driveWander(s); // nothing reachable in range → idle drift this tick
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
        set(t.x, t.y, AIR); // GDD §9: chop the tree → AIR
        markTerrainEdit(t.x, t.y);
        s.carrying += WOOD_PER_CHOP;
        s.carryKind = 'wood';
        harvested = true;
      } else if (role === 'forager' && m === FOLIAGE) {
        set(t.x, t.y, AIR); // GDD §9: gather the bush → AIR
        markTerrainEdit(t.x, t.y);
        s.carrying += FOOD_PER_GATHER;
        s.carryKind = 'food';
        harvested = true;
      } else if (role === 'miner') {
        const out = mineOutput(m); // STONE→stone, ORE→ore (GDD §6.2)
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
        // Target changed under us (burned/edited) — don't waste durability; re-find.
        s.roleState = 'toTarget';
        return;
      }
      // GDD §6.3: the breaking use STILL did its work above — then discard.
      if (useTool(s.tool!)) {
        console.log(`Tool broke: ${role} axe/tool — returning to idle`);
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
    //    the global stockpile (GDD §8) and loop back to find the next target.
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
 * Pick this tick's behaviour by priority (GDD §6.1 auto-override). Full priority
 * including the Phase-6 role loop is:
 *   fleeFire > seekWater(thirst) > seekFood(hunger) > role-loop > wander.
 * This picker resolves the need/fire layer; when it lands on 'wander',
 * updateSurvivor substitutes the role loop if a role + tool are present.
 * Fire interrupts ANYTHING (incl. consuming); otherwise an in-progress consume
 * runs to completion. Switching to a NEW behaviour drops any stale route so the
 * next seek replans fresh. Returns the nearest fire (for the flee driver) when
 * fleeing, else null.
 */
function selectBehaviour(s: Survivor): { x: number; y: number } | null {
  const fire = nearestFire(s.body);
  let next: Behaviour;
  if (fire) {
    next = 'fleeFire';
  } else if (s.behaviour === 'consuming') {
    next = 'consuming'; // stay until done
  } else if (s.needs.thirst < THIRST_THRESHOLD) {
    next = 'seekWater';
  } else if (s.needs.hunger < HUNGER_THRESHOLD) {
    next = 'seekFood';
  } else {
    next = 'wander';
  }
  if (next !== s.behaviour) {
    s.behaviour = next;
    s.path = null;
    s.waypointIndex = 0;
    s.seekTarget = null; // a new behaviour re-acquires its own reachable target
  }
  return fire;
}

/**
 * Advance one survivor by one sim tick. OWNS the body drive: deplete needs →
 * resolve death (Phase-4 handoff) → pick a behaviour (sets moveDir) → step the
 * body. Call once per tick from main.
 */
export function updateSurvivor(s: Survivor, zombies: Zombie[] = []): void {
  const body = s.body;

  // 1. Dead-survivor guard: a dissolved body's cells belong to the sim now.
  if (!body.alive) {
    return;
  }
  // 1a. Turned guard (GDD §7.2): the body has reanimated as a zombie and is now
  //     driven by a Zombie controller. This survivor controller must not touch
  //     it (no needs, no drive, no body step — the zombie owns updateBody now).
  if (s.turned) {
    return;
  }
  // 1b. Prone/downed guard (GDD §7.2): an infected body that has dropped to a
  //     downed state (pre-turn) acts no more — no needs-seek, no fight, no
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

  // 2. Deplete needs (GDD §6.1). Exertion (moving) drains both faster; heat
  //    (FIRE nearby) drains thirst on top of that. "moving" reads the moveDir
  //    set last tick — a cheap, one-tick-lagged proxy for current exertion.
  const exertion = body.moveDir !== 0 ? EXERTION_RATE_MULT : 1;
  const heat = nearFire(body) ? HEAT_THIRST_MULT : 1;
  s.needs.hunger = Math.max(0, s.needs.hunger - HUNGER_RATE * exertion);
  s.needs.thirst = Math.max(0, s.needs.thirst - THIRST_RATE * exertion * heat);

  // 2a. Warmth (Task W1, GDD §6.1/§10): under AMBIENT_COLD a survivor that is
  //     COLD & EXPOSED (no heat source within FIRE_WARMTH_RADIUS, not sheltered)
  //     loses warmth; otherwise (by a fire, or sheltered) it warms back up fast.
  //     Warmth is mainly cold-vs-heat — no exertion factor (you don't freeze
  //     faster by walking). Shelter is W2/W3; W1 treats it as always false.
  const sheltered = false; // W2/W3 wires real shelter
  if (AMBIENT_COLD && !nearWarmth(body) && !sheltered) {
    s.needs.warmth = Math.max(0, s.needs.warmth - WARMTH_RATE);
  } else {
    s.needs.warmth = Math.min(NEED_MAX, s.needs.warmth + WARMTH_RESTORE_RATE);
  }

  // 3. Death (GDD §6.1 failure states): a need at 0 kills the survivor. This is
  //    a QUIET death — the rig LIES DOWN as a prone corpse (layDownCorpse),
  //    NOT the extreme cell-dissolve (revised death model, GDD §5.1: starvation
  //    / thirst → "lies down dead (corpse)"). Log the cause (UI is Phase 9) and
  //    do NOT re-drive the corpse.
  if (s.needs.hunger <= 0) {
    s.deathCause = 'starvation';
  } else if (s.needs.thirst <= 0) {
    s.deathCause = 'thirst';
  } else if (s.needs.warmth <= 0) {
    // GDD §6.1 warmth failure → FREEZE. Still a QUIET death: layDownCorpse
    // (below) lies the rig down as a corpse — never dissolveBody.
    s.deathCause = 'frozen';
  }
  if (s.deathCause !== null) {
    console.log(`Survivor died: ${s.deathCause}`);
    layDownCorpse(body, s.deathCause);
    return;
  }

  // 4. Auto-override (GDD §6.1): crossing a need threshold (or fire nearby) drops
  //    wander and self-preserves. Select the behaviour, then drive it — each
  //    driver only ever sets body.moveDir (local steering); locomotion walks.
  const fire = selectBehaviour(s);
  switch (s.behaviour) {
    case 'fleeFire':
      // selectBehaviour only returns 'fleeFire' when `fire` is non-null.
      driveFleeFire(s, fire!);
      break;
    case 'seekWater':
      driveSeek(s, WATER, 'water');
      break;
    case 'seekFood':
      driveSeek(s, FOLIAGE, 'food');
      break;
    case 'consuming':
      driveConsume(s);
      break;
    case 'wander':
    default:
      // GDD §6.2 role loop: with a role + tool and no active override, work the
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
