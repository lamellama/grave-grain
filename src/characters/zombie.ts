/**
 * characters/zombie.ts — Zombie controller: idle meander + survivor pursuit
 * (GDD §7.1). The long pole of Phase 7; gates the combat/breaching tasks that
 * follow (t3–t7). MOVEMENT ONLY here — NO damage, NO breaching, NO herd-bias /
 * dual-edge / day-night (those are later tasks / vertical-slice per GDD §14).
 *
 * A Zombie WRAPS a hybrid Body (§5.1) exactly like a Survivor wraps one: a thin
 * autonomy layer drives the body across the live terrain by setting
 * `body.moveDir`, and Phase-3 locomotion does the actual walk/step-up/fall/crawl.
 * The controller OWNS the body drive — `updateZombie` is called once per tick and
 * nothing else pokes `moveDir`.
 *
 * BEHAVIOUR (GDD §7.1):
 *   - IDLE   : meander randomly and SLOW. Every ZOMBIE_IDLE_RETARGET_MIN..MAX
 *              ticks it picks a fresh random goal column within ZOMBIE_IDLE_RADIUS
 *              of its CURRENT x and shuffles toward it.
 *   - DETECT : the nearest ALIVE survivor whose body anchor is within senseRadius
 *              (cheap dx²+dy² test) flips the zombie to ATTACK and locks the
 *              target. No survivor in range (or the target died) drops it back to
 *              IDLE.
 *   - ATTACK : pursue the target SLIGHTLY FASTER than idle. Route over the coarse
 *              navgrid (game/pathfinding) to a STANDABLE cell ADJACENT to the
 *              target (never INTO it), advancing waypoints with local steering and
 *              falling back to a straight line toward the target's column. Stops
 *              once adjacent (the strike itself is t3+).
 *
 * SPEED CONTROL (important — locomotion.ts is GATE-locked and always walks at
 * WALK_SPEED whenever moveDir≠0). To make idle SLOWER than a walk and pursuit a
 * DISTINCT speed without editing locomotion, the wrapper gates moveDir with a
 * per-tick sub-cell accumulator (`moveAccum`): each tick we want to move we add
 * the desired speed (ZOMBIE_IDLE_SPEED or ZOMBIE_ATTACK_SPEED); we only allow
 * moveDir≠0 once moveAccum ≥ WALK_SPEED (then subtract WALK_SPEED), otherwise we
 * zero moveDir for that tick. Each ACTUAL step the body takes is a normal
 * WALK_SPEED locomotion step (so the no-tunnel sweep + step-up stay intact), but
 * the AVERAGE horizontal speed ≈ the desired speed: idle 0.12/0.30 ≈ moves ~40%
 * of ticks; attack 0.34 > WALK_SPEED 0.30 so it moves essentially every tick.
 * Any banked excess beyond one step is discarded so a fast (attack) accumulator
 * can't run away.
 *
 * DOM-free pure logic so it stays headless-testable; `Survivor`/`Body` are
 * imported as TYPES only to avoid runtime import cycles with those modules.
 */

import type { Body } from './body';
import { createBody } from './body';
import { updateBody } from './locomotion';
import type { Survivor } from './survivor';
import type { Path } from '../game/pathfinding';
import { findPath, isPathStale } from '../game/pathfinding';
import { bodiesAdjacent, pickAttackRegion, meleeAttack } from '../game/combat';
import {
  SENSE_RADIUS,
  ATTACK_COOLDOWN,
  ZOMBIE_IDLE_SPEED,
  ZOMBIE_ATTACK_SPEED,
  ZOMBIE_IDLE_RETARGET_MIN,
  ZOMBIE_IDLE_RETARGET_MAX,
  ZOMBIE_IDLE_RADIUS,
  ZOMBIE_SPAWN_EDGE,
  WANDER_ARRIVE_DIST,
  ATTACK_REACH,
  PATH_REPATH_COOLDOWN,
  WALK_SPEED,
  WORLD_W,
} from '../config';

/**
 * A zombie: a hybrid Body plus the AI/pathing state that drives it (GDD §7.1).
 *   state         : 'idle' meander | 'attack' pursuit.
 *   target        : the body being pursued (null while idle).
 *   senseRadius   : detection range (cells) for the dx²+dy² survivor probe.
 *   attackCooldown: ticks until the next strike is allowed (combat is t3+; here
 *                   it is just counted down so the field is ready for t3).
 *   tick          : monotonic per-zombie tick counter (repath-throttle clock).
 *   lastRepath    : tick of the last findPath (gates PATH_REPATH_COOLDOWN).
 *   path          : active navgrid route (null = none/blocked).
 *   waypointIndex : next waypoint to reach along `path`.
 *   idleGoalX     : current random meander goal column (null = pick a new one).
 *   idleTicks     : countdown to the next idle retarget.
 *   moveAccum     : sub-cell horizontal accumulator for the speed gate (above).
 */
export interface Zombie {
  body: Body;
  state: 'idle' | 'attack';
  target: Body | null;
  senseRadius: number;
  attackCooldown: number;
  tick: number;
  lastRepath: number;
  path: Path | null;
  waypointIndex: number;
  idleGoalX: number | null;
  idleTicks: number;
  moveAccum: number;
}

/**
 * Create a zombie at feet-centre (x, y): body spawned there, idle, no target,
 * senseRadius = SENSE_RADIUS, cooldown/accumulators zeroed and no route yet.
 */
export function createZombie(x: number, y: number): Zombie {
  return {
    body: createBody(x, y),
    state: 'idle',
    target: null,
    senseRadius: SENSE_RADIUS,
    attackCooldown: 0,
    tick: 0,
    // Negative so the very first pursuit repaths immediately (no cooldown wait).
    lastRepath: -PATH_REPATH_COOLDOWN,
    path: null,
    waypointIndex: 0,
    idleGoalX: null,
    idleTicks: 0,
    moveAccum: 0,
  };
}

/** Inclusive random integer in [lo, hi]. */
function randInt(lo: number, hi: number): number {
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

/**
 * Detection (GDD §7.1): the nearest ALIVE survivor whose body anchor is within
 * senseRadius of the zombie, by a cheap squared-distance compare (no sqrt). A
 * dead/dissolved survivor is skipped (its cells belong to the sim now). Returns
 * the chosen body, or null if none is in range.
 */
function nearestSurvivor(z: Zombie, survivors: Survivor[]): Body | null {
  const bx = z.body.x;
  const by = z.body.y;
  const r2 = z.senseRadius * z.senseRadius;
  let best: Body | null = null;
  let bestD = Infinity;
  for (const s of survivors) {
    if (!s.body.alive) continue;
    const dx = s.body.x - bx;
    const dy = s.body.y - by;
    const d = dx * dx + dy * dy;
    if (d <= r2 && d < bestD) {
      bestD = d;
      best = s.body;
    }
  }
  return best;
}

/**
 * Local steering toward a goal cell (mirrors survivor.steerToCell): (re)plan a
 * navgrid route when missing or LOCALLY stale (throttled by PATH_REPATH_COOLDOWN),
 * then set body.moveDir toward the next waypoint's x, advancing waypoints within
 * ~1 cell. With no usable path, steer straight at `fallbackX` as a best effort.
 * The caller chooses the goal (a standable cell ADJACENT to the target) — we
 * never path INTO a target.
 */
function steerToCell(
  z: Zombie,
  goalX: number,
  goalY: number,
  fallbackX: number,
): void {
  const body = z.body;
  const bx = Math.round(body.x);
  const needPath = z.path === null || isPathStale(z.path);
  if (needPath && z.tick - z.lastRepath >= PATH_REPATH_COOLDOWN) {
    z.lastRepath = z.tick;
    z.path = findPath(bx, Math.round(body.y), goalX, goalY);
    z.waypointIndex = 0;
  }
  if (z.path && z.path.waypoints.length > 0) {
    while (
      z.waypointIndex < z.path.waypoints.length &&
      Math.abs(bx - z.path.waypoints[z.waypointIndex].x) <= 1
    ) {
      z.waypointIndex++;
    }
    const target =
      z.waypointIndex < z.path.waypoints.length
        ? z.path.waypoints[z.waypointIndex].x
        : fallbackX;
    body.moveDir = target > bx ? 1 : target < bx ? -1 : 0;
  } else {
    body.moveDir = fallbackX > bx ? 1 : fallbackX < bx ? -1 : 0;
  }
}

/**
 * Idle meander (GDD §7.1 "meander randomly, slow"): pick a random goal column
 * within ZOMBIE_IDLE_RADIUS of the CURRENT x, shuffle toward it, and repick on a
 * randomised ZOMBIE_IDLE_RETARGET_MIN..MAX timer or on arrival. Sets moveDir
 * only; the speed gate downstream makes the actual drift slow. Never touches the
 * grid or a path — meander is pure local steering.
 */
// The colony sits on the OPPOSITE edge from the zombie spawn edge, so idle
// zombies advance in this direction (+1 = toward higher x, i.e. colony when they
// spawn on the left edge; -1 when they spawn on the right).
const ADVANCE_DIR: 1 | -1 = ZOMBIE_SPAWN_EDGE === 'left' ? 1 : -1;

function driveIdle(z: Zombie): void {
  const body = z.body;
  const bx = Math.round(body.x);

  // Pick a new goal when none is set or the retarget timer has elapsed.
  // Idle zombies DON'T just shuffle in place — they DRIFT toward the colony
  // (the opposite edge from where they spawned) so a horde actually advances
  // across the wide map and reaches the base even before it senses a survivor
  // (GDD §7.1 tower-defense advance). The goal is biased forward (mostly toward
  // the colony) with a little wobble so it still reads as a meander, not a march.
  if (z.idleGoalX === null || z.idleTicks <= 0) {
    const forward = randInt(3, ZOMBIE_IDLE_RADIUS) * ADVANCE_DIR; // mostly toward colony
    const wobble = randInt(-3, 3); // small meander on top of the forward drift
    z.idleGoalX = Math.min(WORLD_W - 1, Math.max(0, bx + forward + wobble));
    z.idleTicks = randInt(ZOMBIE_IDLE_RETARGET_MIN, ZOMBIE_IDLE_RETARGET_MAX);
  }
  z.idleTicks--;

  // Arrived → stand still (and let the timer pick the next goal).
  const dx = z.idleGoalX - bx;
  if (Math.abs(dx) <= WANDER_ARRIVE_DIST) {
    z.idleGoalX = null;
    body.moveDir = 0;
    return;
  }
  body.moveDir = dx > 0 ? 1 : -1;
}

/**
 * Attack-move (GDD §7.1): pursue the target via the navgrid router + local
 * steering. Stop once adjacent (within ATTACK_REACH columns) — the strike is
 * t3+; this task only walks the zombie up to the survivor. We path to a
 * standable cell ONE column on the zombie's side of the target so the route ends
 * BESIDE, never inside, it; the fallback steers straight at the target's column.
 */
function driveAttack(z: Zombie, target: Body): void {
  const body = z.body;
  const bx = Math.round(body.x);
  const tx = Math.round(target.x);

  if (Math.abs(bx - tx) <= ATTACK_REACH) {
    body.moveDir = 0; // adjacent → hold (combat lands in t3)
    return;
  }
  const side = bx <= tx ? -1 : 1;
  steerToCell(z, tx + side, Math.round(target.y), tx);
}

/**
 * Advance one zombie by one sim tick (GDD §7.1). OWNS the body drive: tick the
 * cooldown → detect/lock a target → drive the matching behaviour (which sets
 * moveDir) → apply the sub-cell speed gate → step the body. Call once per tick.
 */
export function updateZombie(z: Zombie, survivors: Survivor[]): void {
  // 1. Dead-body guard: a dissolved zombie's cells belong to the sim now.
  if (!z.body.alive) {
    return;
  }

  // 2. Cooldown clock (combat is t3+; we only keep it counting here) + tick.
  if (z.attackCooldown > 0) z.attackCooldown--;
  z.tick++;

  // 3. Detect (GDD §7.1): lock the nearest in-range alive survivor → attack;
  //    none (or target died) → idle. Switching state drops any stale route so
  //    the next drive replans fresh.
  const prevState = z.state;
  const target = nearestSurvivor(z, survivors);
  if (target) {
    z.state = 'attack';
    z.target = target;
  } else {
    z.state = 'idle';
    z.target = null;
  }
  if (z.state !== prevState) {
    z.path = null;
    z.waypointIndex = 0;
  }

  // 4. Drive the behaviour (sets body.moveDir = the DESIRED direction this tick)
  //    and choose the desired average speed for the gate below.
  let speed: number;
  if (z.state === 'attack' && z.target) {
    driveAttack(z, z.target);
    speed = ZOMBIE_ATTACK_SPEED;
  } else {
    driveIdle(z);
    speed = ZOMBIE_IDLE_SPEED;
  }

  // 4b. Melee strike (GDD §7.2, THE GATE): an adjacent attacking zombie whose
  //     cooldown is ready wounds its target — meleeAttack → applyDamage RELEASES
  //     the chosen region's pixels into the live sim (real limb loss / head→
  //     torso death). While adjacent we HOLD (moveDir 0) so the strike replaces
  //     movement and the zombie never walks into the target. Cooldown gates the
  //     cadence so it can't hit every tick.
  if (
    z.state === 'attack' &&
    z.target &&
    z.target.alive &&
    bodiesAdjacent(z.body, z.target)
  ) {
    z.body.moveDir = 0; // hold position while in reach
    if (z.attackCooldown <= 0) {
      const region = pickAttackRegion(z.target, 'auto');
      if (region) meleeAttack(z.target, region);
      z.attackCooldown = ATTACK_COOLDOWN;
    }
  }

  // 5. Sub-cell speed gate (see file header). Only bank intent on ticks we
  //    actually want to move; release one WALK_SPEED step once enough has
  //    accumulated, else stand still this tick. Cap the bank at one step so a
  //    fast (attack) accumulator can't run away.
  if (z.body.moveDir !== 0) {
    z.moveAccum += speed;
    if (z.moveAccum >= WALK_SPEED) {
      z.moveAccum -= WALK_SPEED; // spend one whole-cell walk step
    } else {
      z.body.moveDir = 0; // not enough banked yet → no step this tick
    }
    if (z.moveAccum > WALK_SPEED) z.moveAccum = WALK_SPEED;
  }

  // 6. Step the body with the gated drive (locomotion does walk/step-up/fall).
  updateBody(z.body);
}
