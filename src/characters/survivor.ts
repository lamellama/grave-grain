/**
 * characters/survivor.ts — Survivor controller: needs + autonomy (GDD §6.1).
 *
 * A Survivor WRAPS a hybrid Body (§5.1) with a small autonomy layer: needs that
 * deplete over time and a behaviour that drives the body across the live terrain
 * by setting `body.moveDir`. This controller OWNS the body drive — main calls
 * updateSurvivor once per tick and never pokes moveDir itself.
 *
 * SCOPE (MVP per GDD §6.1): Hunger + Thirst only (Warmth is OUT of MVP), role
 * fixed 'none'. Needs deplete faster with exertion (moving) and, for thirst,
 * near heat (FIRE). When a need hits 0 the survivor dies through the existing
 * Phase-4 death-collapse (dissolveBody → cells into the live sim).
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
import { dissolveBody } from './damage';
import { get, set } from '../engine/grid';
import { FIRE, WATER, FOLIAGE, AIR } from '../engine/materials';
import { markTerrainEdit } from '../engine/navgrid';
import type { Path } from '../game/pathfinding';
import { findPath, isPathStale } from '../game/pathfinding';
import {
  NEED_MAX,
  HUNGER_RATE,
  THIRST_RATE,
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
  FLEE_FIRE_RADIUS,
  PATH_REPATH_COOLDOWN,
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
 * route (p5-t4); `role` is reserved for Phase 6 and is inert in this MVP.
 */
export interface Survivor {
  body: Body;
  needs: { hunger: number; thirst: number };
  home: { x: number; y: number };
  role: 'none';
  behaviour: Behaviour;
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
}

/**
 * Create a survivor at feet-centre (x, y): body spawned there, both needs full,
 * home = spawn, role 'none', behaviour 'wander', no path/death yet.
 */
export function createSurvivor(x: number, y: number): Survivor {
  return {
    body: createBody(x, y),
    needs: { hunger: NEED_MAX, thirst: NEED_MAX },
    home: { x, y },
    role: 'none',
    behaviour: 'wander',
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
 * test: the survivor consumes a resource it can touch without overlapping it
 * (bodies collide with FOLIAGE / can't stand in WATER, so reach — never overlap
 * — is the correct contact rule).
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
  const bx = Math.round(body.x);
  const by = Math.round(body.y);

  // 1. Arrival → consume in place.
  const reach = resourceWithinReach(body, mat);
  if (reach) {
    s.behaviour = 'consuming';
    s.consumeTicks = kind === 'water' ? DRINK_TICKS : EAT_TICKS;
    s.consumeKind = kind;
    s.consumeCell = kind === 'food' ? reach : null;
    s.path = null;
    body.moveDir = 0;
    return;
  }

  // 2. Target scan. Nothing in range → wander (and keep depleting → may die).
  const res = nearestMaterial(bx, by, mat, RESOURCE_SCAN_RADIUS);
  if (!res) {
    driveWander(s);
    return;
  }

  // 3. Path to a STANDABLE cell on the body's side of the resource (one column
  //    in from it) so the route ends beside, never inside, the resource.
  const side = bx <= res.x ? -1 : 1;
  const goalX = res.x + side;
  const goalY = res.y;
  const needPath = s.path === null || isPathStale(s.path);
  if (needPath && s.tick - s.lastRepath >= PATH_REPATH_COOLDOWN) {
    s.lastRepath = s.tick;
    s.path = findPath(bx, by, goalX, goalY);
    s.waypointIndex = 0;
  }

  // 4. Local steering toward the next waypoint; on path-end (or no path) steer
  //    straight at the resource column as a fallback.
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
        : res.x;
    body.moveDir = target > bx ? 1 : target < bx ? -1 : 0;
  } else {
    body.moveDir = res.x > bx ? 1 : res.x < bx ? -1 : 0;
  }
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
 * Pick this tick's behaviour by priority (GDD §6.1 auto-override):
 *   fleeFire > seekWater(thirst) > seekFood(hunger) > wander.
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
  }
  return fire;
}

/**
 * Advance one survivor by one sim tick. OWNS the body drive: deplete needs →
 * resolve death (Phase-4 handoff) → pick a behaviour (sets moveDir) → step the
 * body. Call once per tick from main.
 */
export function updateSurvivor(s: Survivor): void {
  const body = s.body;

  // 1. Dead-survivor guard: a dissolved body's cells belong to the sim now.
  if (!body.alive) {
    return;
  }
  s.tick++;

  // 2. Deplete needs (GDD §6.1). Exertion (moving) drains both faster; heat
  //    (FIRE nearby) drains thirst on top of that. "moving" reads the moveDir
  //    set last tick — a cheap, one-tick-lagged proxy for current exertion.
  const exertion = body.moveDir !== 0 ? EXERTION_RATE_MULT : 1;
  const heat = nearFire(body) ? HEAT_THIRST_MULT : 1;
  s.needs.hunger = Math.max(0, s.needs.hunger - HUNGER_RATE * exertion);
  s.needs.thirst = Math.max(0, s.needs.thirst - THIRST_RATE * exertion * heat);

  // 3. Death (GDD §6.1 failure states): a need at 0 kills the survivor through
  //    the Phase-4 death-collapse (dissolveBody releases every bone into the
  //    live sim). Log the cause (UI is Phase 9) and do NOT re-drive the corpse.
  if (s.needs.hunger <= 0) {
    s.deathCause = 'starvation';
  } else if (s.needs.thirst <= 0) {
    s.deathCause = 'thirst';
  }
  if (s.deathCause !== null) {
    console.log(`Survivor died: ${s.deathCause}`);
    dissolveBody(body);
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
      driveWander(s);
      break;
  }

  // 5. Step the body with the freshly-set drive.
  updateBody(body);
}
