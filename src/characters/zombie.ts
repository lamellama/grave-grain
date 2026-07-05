/**
 * characters/zombie.ts - Zombie controller: idle meander + survivor pursuit
 * (GDD 7.1). The long pole of Phase 7; gates the combat/breaching tasks that
 * follow (t3-t7). Post-MVP additions layered on since: bite/turn (7.2),
 * ladder-climb (v0.5 #A) and HERD DYNAMICS (7.1 "follow the crowd" - the
 * authorized vertical-slice item; see herdPullX/driveIdle). Still NO
 * dual-edge / day-night (later items per GDD 14).
 *
 * A Zombie WRAPS a hybrid Body (5.1) exactly like a Survivor wraps one: a thin
 * autonomy layer drives the body across the live terrain by setting
 * `body.moveDir`, and Phase-3 locomotion does the actual walk/step-up/fall/crawl.
 * The controller OWNS the body drive - `updateZombie` is called once per tick and
 * nothing else pokes `moveDir`.
 *
 * BEHAVIOUR (GDD 7.1):
 *   - IDLE   : meander randomly and SLOW. Every ZOMBIE_IDLE_RETARGET_MIN..MAX
 *              ticks it picks a fresh random goal column within ZOMBIE_IDLE_RADIUS
 *              of its CURRENT x and shuffles toward it.
 *   - DETECT : the nearest ALIVE survivor whose body anchor is within senseRadius
 *              (cheap dx2+dy2 test) flips the zombie to ATTACK and locks the
 *              target. No survivor in range (or the target died) drops it back to
 *              IDLE.
 *   - ATTACK : pursue the target SLIGHTLY FASTER than idle. Route over the coarse
 *              navgrid (game/pathfinding) to a STANDABLE cell ADJACENT to the
 *              target (never INTO it), advancing waypoints with local steering and
 *              falling back to a straight line toward the target's column. Stops
 *              once adjacent (the strike itself is t3+).
 *
 * SPEED CONTROL (important - locomotion.ts is GATE-locked and always walks at
 * WALK_SPEED whenever moveDir!=0). To make idle SLOWER than a walk and pursuit a
 * DISTINCT speed without editing locomotion, the wrapper gates moveDir with a
 * per-tick sub-cell accumulator (`moveAccum`): each tick we want to move we add
 * the desired speed (ZOMBIE_IDLE_SPEED or ZOMBIE_ATTACK_SPEED); we only allow
 * moveDir!=0 once moveAccum >= WALK_SPEED (then subtract WALK_SPEED), otherwise we
 * zero moveDir for that tick. Each ACTUAL step the body takes is a normal
 * WALK_SPEED locomotion step (so the no-tunnel sweep + step-up stay intact), but
 * the AVERAGE horizontal speed ~ the desired speed: idle 0.12/0.30 ~ moves ~40%
 * of ticks; attack 0.34 > WALK_SPEED 0.30 so it moves essentially every tick.
 * Any banked excess beyond one step is discarded so a fast (attack) accumulator
 * can't run away.
 *
 * DOM-free pure logic so it stays headless-testable; `Survivor`/`Body` are
 * imported as TYPES only to avoid runtime import cycles with those modules.
 */

import type { Body } from './body';
import { createBody } from './body';
import { updateBody, bodyCellsSolidAt } from './locomotion';
import { zombieFooting } from './zombieFooting';
import type { Survivor } from './survivor';
import type { Path } from '../game/pathfinding';
import { findPath, isPathStale } from '../game/pathfinding';
import { bodiesAdjacent, biteAttack } from '../game/combat';
import { idx } from '../engine/grid';
import {
  SENSE_RADIUS,
  ATTACK_COOLDOWN,
  ZOMBIE_IDLE_SPEED,
  ZOMBIE_ATTACK_SPEED,
  ZOMBIE_IDLE_RETARGET_MIN,
  ZOMBIE_IDLE_RETARGET_MAX,
  ZOMBIE_IDLE_RADIUS,
  ZOMBIE_HERD_RADIUS,
  ZOMBIE_HERD_BIAS,
  ZOMBIE_HERD_PULL_MAX,
  ZOMBIE_SPAWN_EDGE,
  WANDER_ARRIVE_DIST,
  ATTACK_REACH,
  PATH_REPATH_COOLDOWN,
  WALK_SPEED,
  WORLD_W,
  STEP_UP_MAX,
  ZOMBIE_CLIMB_MAX,
  ZOMBIE_CLIMB_ENABLED,
} from '../config';

/**
 * A zombie: a hybrid Body plus the AI/pathing state that drives it (GDD 7.1).
 *   state         : 'idle' meander | 'attack' pursuit.
 *   target        : the body being pursued (null while idle).
 *   senseRadius   : detection range (cells) for the dx2+dy2 survivor probe.
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
  const body = createBody(x, y);
  // Undead don't breathe (playtest v0.9 Q): a zombie sinks (buoyant stays
  // false) and walks the lake BOTTOM without the drown clock ever running.
  body.breathes = false;
  return {
    body,
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

/**
 * Reanimate an EXISTING body as a zombie (revised death model, GDD 5.1 outcome
 * 3 / 7.2 turning). Unlike createZombie this does NOT createBody - it WRAPS the
 * passed-in (infected, downed) Body so the reanimated zombie reuses the SAME rig
 * and the controller-swap is seamless (THE GATE: the intact reused rig means a
 * later headshot/dissolve on this zombie still releases real cells). The rig is
 * left as-is (alive===true) apart from its water flags (it is undead now - see
 * below); fresh idle/steering bookkeeping is created, identical to
 * createZombie's defaults.
 */
export function reanimateAsZombie(body: Body): Zombie {
  // The wrapped body is undead now (playtest v0.9 Q): it stops floating (a
  // turned survivor sinks and bottom-walks like any zombie) and stops breathing
  // (the drown clock never runs again).
  body.buoyant = false;
  body.breathes = false;
  return {
    body,
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
 * Detection (GDD 7.1): the nearest ALIVE survivor whose body anchor is within
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
    // Skip the doomed/turned (revised death model, GDD 7.2): don't re-bite an
    // already-infected or downed survivor (it's turning anyway), and never
    // target a survivor whose body has already reanimated into the horde.
    if (s.body.infected || s.body.prone || s.turned) continue;
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
 * The caller chooses the goal (a standable cell ADJACENT to the target) - we
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
 * Herd pull (GDD 7.1 herd behaviour): the horizontal bias a zombie's next idle
 * goal receives from nearby allies. Averages the anchor x of every OTHER alive
 * zombie within ZOMBIE_HERD_RADIUS (2D squared-distance probe, no sqrt), caps
 * the centroid offset at +/-ZOMBIE_HERD_PULL_MAX and scales it by
 * ZOMBIE_HERD_BIAS. Returns 0 with no neighbours in range - a lone zombie
 * meanders exactly as before. Pure and exported for the herd test; called only
 * at retarget time (driveIdle), never per tick, so the O(zombies) scan is
 * amortized over ZOMBIE_IDLE_RETARGET_MIN..MAX ticks (GDD 13).
 */
export function herdPullX(z: Zombie, herd: readonly Zombie[]): number {
  const bx = z.body.x;
  const by = z.body.y;
  const r2 = ZOMBIE_HERD_RADIUS * ZOMBIE_HERD_RADIUS;
  let sumX = 0;
  let n = 0;
  for (const other of herd) {
    if (other === z || !other.body.alive) continue;
    const dx = other.body.x - bx;
    const dy = other.body.y - by;
    if (dx * dx + dy * dy > r2) continue;
    sumX += other.body.x;
    n++;
  }
  if (n === 0) return 0;
  const toCentroid = sumX / n - bx;
  const capped = Math.max(
    -ZOMBIE_HERD_PULL_MAX,
    Math.min(ZOMBIE_HERD_PULL_MAX, toCentroid),
  );
  return capped * ZOMBIE_HERD_BIAS;
}

/**
 * Idle meander (GDD 7.1 "meander randomly, slow"): pick a random goal column
 * within ZOMBIE_IDLE_RADIUS of the CURRENT x, shuffle toward it, and repick on a
 * randomised ZOMBIE_IDLE_RETARGET_MIN..MAX timer or on arrival. Sets moveDir
 * only; the speed gate downstream makes the actual drift slow. Never touches the
 * grid or a path - meander is pure local steering.
 */
// The colony sits on the OPPOSITE edge from the zombie spawn edge, so idle
// zombies advance in this direction (+1 = toward higher x, i.e. colony when they
// spawn on the left edge; -1 when they spawn on the right).
const ADVANCE_DIR: 1 | -1 = ZOMBIE_SPAWN_EDGE === 'left' ? 1 : -1;

function driveIdle(z: Zombie, herd: readonly Zombie[]): void {
  const body = z.body;
  const bx = Math.round(body.x);

  // Pick a new goal when none is set or the retarget timer has elapsed.
  // Idle zombies DON'T just shuffle in place - they DRIFT toward the colony
  // (the opposite edge from where they spawned) so a horde actually advances
  // across the wide map and reaches the base even before it senses a survivor
  // (GDD 7.1 tower-defense advance). The goal is biased forward (mostly toward
  // the colony) with a little wobble so it still reads as a meander, not a march.
  // HERD BEHAVIOUR (GDD 7.1, vertical slice): the goal is additionally pulled
  // toward the local herd centroid (herdPullX) - a straggler behind a clump
  // gets tugged after it, a runner ahead is reined back, and loose spawns
  // congeal into a crowd while the forward march stays intact.
  if (z.idleGoalX === null || z.idleTicks <= 0) {
    const forward = randInt(3, ZOMBIE_IDLE_RADIUS) * ADVANCE_DIR; // mostly toward colony
    const wobble = randInt(-3, 3); // small meander on top of the forward drift
    const pull = Math.round(herdPullX(z, herd)); // toward nearby allies (0 if alone)
    z.idleGoalX = Math.min(WORLD_W - 1, Math.max(0, bx + forward + wobble + pull));
    z.idleTicks = randInt(ZOMBIE_IDLE_RETARGET_MIN, ZOMBIE_IDLE_RETARGET_MAX);
  }
  z.idleTicks--;

  // Arrived -> stand still (and let the timer pick the next goal).
  const dx = z.idleGoalX - bx;
  if (Math.abs(dx) <= WANDER_ARRIVE_DIST) {
    z.idleGoalX = null;
    body.moveDir = 0;
    return;
  }
  body.moveDir = dx > 0 ? 1 : -1;
}

/**
 * Attack-move (GDD 7.1): pursue the target via the navgrid router + local
 * steering. Stop once adjacent (within ATTACK_REACH columns) - the strike is
 * t3+; this task only walks the zombie up to the survivor. We path to a
 * standable cell ONE column on the zombie's side of the target so the route ends
 * BESIDE, never inside, it; the fallback steers straight at the target's column.
 */
function driveAttack(z: Zombie, target: Body): void {
  const body = z.body;
  const bx = Math.round(body.x);
  const tx = Math.round(target.x);

  if (Math.abs(bx - tx) <= ATTACK_REACH) {
    body.moveDir = 0; // adjacent -> hold (combat lands in t3)
    return;
  }
  const side = bx <= tx ? -1 : 1;
  steerToCell(z, tx + side, Math.round(target.y), tx);
}

// ===========================================================================
// Zombie ladder-climb (post-MVP backlog, playtest v0.5 #A; GDD 7.1 funnel).
//
// ADDITIVE behaviour layered on top of the shared GATE locomotion: updateBody is
// NEVER changed. When an ATTACKING zombie is blocked by a wall taller than
// STEP_UP_MAX AND ally zombie bodies are piled at it, the blocked zombie steps UP
// onto an ally body (treating the ally's occupied cells - the per-tick
// `zombieFooting` map - as standable footing) and over the wall. A LONE zombie
// has no ally footing (the map holds only its own cells, which are excluded), so
// it can never climb and breaches instead. No-tunnel is non-negotiable: the
// climbing zombie never overlaps a GRID solid (every raised position is rejected
// via bodyCellsSolidAt against the grid); it may visually overlap ally sprites
// (that's the pile - bodies aren't grid-collided with each other).
// ===========================================================================

/**
 * Build the set of world-cell indices this body occupies at the given rounded
 * anchor (ox, oy), over its non-destroyed bones. Cheap (<= rig pixels). Used to
 * exclude the climber's OWN cells from the ally-footing test (a zombie can't
 * stand on itself) - see allyFootingUnder.
 */
function ownCellSet(body: Body, ox: number, oy: number): Set<number> {
  const out = new Set<number>();
  for (const bone of body.rig) {
    if (bone.destroyed) continue;
    for (const p of bone.pixels) {
      out.add(idx(ox + bone.offset.dx + p.dx, oy + bone.offset.dy + p.dy));
    }
  }
  return out;
}

/**
 * Is there ALLY-BODY footing directly below the body's CONTACT pixels when it is
 * translated by (dxCells, dyCells) whole cells? "Footing" here is deliberately
 * ALLY-ONLY (an ally cell in the per-tick `zombieFooting` map) - NOT grid solid.
 *
 * Why ally-only: a GRID-footing allowance would let a LONE zombie scale a sheer
 * wall by standing on the wall's own cells (defeating "a lone zombie can't
 * climb"). The climb only needs to ride the ALLY pile UPward; once a zombie is
 * high enough that the wall no longer blocks it, the shared updateBody's normal
 * step-up/walk carries it over the top and down the far side. So grid footing is
 * never needed by the climb itself.
 *
 * For each pixel we look at the cell directly below it; we SKIP pixels whose
 * below-cell is one of the body's own (translated) cells - those are internal,
 * not a contact face, so only genuine bottom-edge feet are tested. The footing
 * MAP was built from the bodies' CURRENT positions, so its count at a cell
 * INCLUDES this body's own current contribution; we subtract that one
 * (ownCurrent) and treat the cell as ally footing only if SOMEONE ELSE is still
 * there (count - self > 0). That lets a PERFECTLY-overlapping ally count (a crowd
 * pressing a wall stops at the same x) while stopping a lone zombie from treating
 * itself as footing (no allies -> nothing left after subtraction).
 */
function allyFootingUnder(
  body: Body,
  dxCells: number,
  dyCells: number,
  ownCurrent: Set<number>,
): boolean {
  const cx = Math.round(body.x);
  const cy = Math.round(body.y);
  const tx = cx + dxCells;
  const ty = cy + dyCells;
  const ownTranslated = ownCellSet(body, tx, ty);
  for (const bone of body.rig) {
    if (bone.destroyed) continue;
    for (const p of bone.pixels) {
      const bx = tx + bone.offset.dx + p.dx;
      const by = ty + bone.offset.dy + p.dy + 1; // cell directly below
      const bi = idx(bx, by);
      if (ownTranslated.has(bi)) continue; // internal pixel -> not a contact face
      const allies = (zombieFooting.get(bi) ?? 0) - (ownCurrent.has(bi) ? 1 : 0);
      if (allies > 0) return true; // ally-body footing (excluding self's own cell)
    }
  }
  return false;
}

/** Would a normal walk/step-up (1..STEP_UP_MAX) succeed in direction `step`? */
function normalStepClear(body: Body, step: 1 | -1): boolean {
  if (!bodyCellsSolidAt(body, step, 0)) return true;
  for (let h = 1; h <= STEP_UP_MAX; h++) {
    if (!bodyCellsSolidAt(body, step, -h)) return true;
  }
  return false;
}

/**
 * Attempt the ladder-climb for one ATTACKING zombie this tick. Returns true iff
 * it HANDLED the zombie's locomotion (climbed a step, or is holding on the pile)
 * - in which case the caller must NOT also run updateBody (that would undo the
 * climb by falling through the ally sprites). Returns false to defer to the
 * normal shared locomotion (walk/step-up/fall) - including walking forward and
 * falling down the FAR side once the zombie is up over the wall top.
 *
 * Rules:
 *   - Climb direction is toward the target (the pursuit direction).
 *   - Only when BLOCKED beyond STEP_UP_MAX (a normal step-up would've handled a
 *     gentle slope; we don't interfere there).
 *   - Climb STEP (rise up to ZOMBIE_CLIMB_MAX onto the pile) is paced by the
 *     speed gate (only on a tick the zombie actually wants to step, moveDir==step)
 *     and requires (a) the raised position is grid-clear (no-tunnel) AND (b) ally
 *     /grid footing under the raised feet.
 *   - If it can't climb yet but IS already up on the pile (supported only by ally
 *     footing, no grid below), it HOLDS - so the pile doesn't collapse between
 *     steps while it waits for more allies to climb past it.
 */
function zombieClimb(z: Zombie): boolean {
  if (!ZOMBIE_CLIMB_ENABLED) return false;
  const body = z.body;
  const target = z.target;
  if (!target) return false;

  const step: 1 | -1 = Math.round(target.x) >= Math.round(body.x) ? 1 : -1;

  const ownCurrent = ownCellSet(body, Math.round(body.x), Math.round(body.y));
  const gridGrounded = bodyCellsSolidAt(body, 0, 1);
  const onPile = !gridGrounded && allyFootingUnder(body, 0, 0, ownCurrent);

  // Not blocked by a tall wall -> let normal locomotion run. (If we're on the
  // pile this is the walk-over-the-top / fall-down-the-far-side case - updateBody
  // correctly carries the zombie across and down.)
  if (normalStepClear(body, step)) {
    return false;
  }

  // Blocked beyond STEP_UP_MAX. Try to mount the pile this tick - but only on a
  // tick the speed gate released a step in our pursuit direction, so the climb
  // cadence matches the walk.
  if (body.moveDir === step) {
    for (let h = 1; h <= ZOMBIE_CLIMB_MAX; h++) {
      if (bodyCellsSolidAt(body, step, -h)) continue; // would enter grid solid -> no-tunnel
      if (allyFootingUnder(body, step, -h, ownCurrent)) {
        body.x += step; // climb onto the pile and over
        body.y -= h;
        body.grounded = true;
        body.vy = 0;
        return true;
      }
    }
  }

  // Couldn't climb this tick. If we're already up on the pile, HOLD (don't fall
  // through the allies beneath us) so the pile persists for the next climber.
  if (onPile) {
    body.grounded = true;
    body.vy = 0;
    return true;
  }

  // At the wall base on real ground -> defer: updateBody presses the wall (and
  // breaching/biting proceed as normal). The crowd piles as later arrivals climb.
  return false;
}

/**
 * Advance one zombie by one sim tick (GDD 7.1). OWNS the body drive: tick the
 * cooldown -> detect/lock a target -> drive the matching behaviour (which sets
 * moveDir) -> apply the sub-cell speed gate -> step the body. Call once per tick.
 * `herd` is the full zombie list (self included - herdPullX skips it) used for
 * the idle herd bias; it defaults to empty so herd-less callers (older tests)
 * keep the exact pre-herd behaviour.
 */
export function updateZombie(
  z: Zombie,
  survivors: Survivor[],
  herd: readonly Zombie[] = [],
): void {
  // 1. Dead-body guard: a dissolved zombie's cells belong to the sim now.
  if (!z.body.alive) {
    return;
  }

  // 2. Cooldown clock (combat is t3+; we only keep it counting here) + tick.
  if (z.attackCooldown > 0) z.attackCooldown--;
  z.tick++;

  // 3. Detect (GDD 7.1): lock the nearest in-range alive survivor -> attack;
  //    none (or target died) -> idle. Switching state drops any stale route so
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
    driveIdle(z, herd);
    speed = ZOMBIE_IDLE_SPEED;
  }

  // 4b. Bite (GDD 7.2 "bite & turning" / 5.1 outcome 3): a zombie's signature
  //     melee is a BITE that INFECTS - NOT the guard's dismembering meleeAttack.
  //     An adjacent attacking zombie whose cooldown is ready bites its target,
  //     marking it infected (biteAttack); it releases NO cells, destroys NO
  //     bones and never trips THE GATE/dissolve (the acting->prone->turn that
  //     follows is Task 4). While adjacent we HOLD (moveDir 0) so the bite
  //     replaces movement and the zombie never walks into the target. Cooldown
  //     gates the cadence so it can't bite every tick; we re-arm it even when
  //     the target is already infected (a re-bite is wasted, but the zombie
  //     still gnaws in place rather than shoving past).
  if (
    z.state === 'attack' &&
    z.target &&
    z.target.alive &&
    bodiesAdjacent(z.body, z.target)
  ) {
    z.body.moveDir = 0; // hold position while in reach
    if (z.attackCooldown <= 0) {
      biteAttack(z.target); // bite -> infect (no dismember / no GATE)
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
      z.body.moveDir = 0; // not enough banked yet -> no step this tick
    }
    if (z.moveAccum > WALK_SPEED) z.moveAccum = WALK_SPEED;
  }

  // 5b. Ladder-climb (post-MVP backlog, playtest v0.5 #A): an attacking zombie
  //     blocked by a wall taller than STEP_UP_MAX with ally bodies piled at it
  //     steps UP onto the pile (ally cells = footing) and over the wall. ADDITIVE
  //     - gated on attack state + ally footing; never touches shared updateBody.
  //     If it handled locomotion this tick (climbed/holding on the pile), skip
  //     updateBody so the fall doesn't drop it back through the ally sprites.
  if (z.state === 'attack' && z.target && zombieClimb(z)) {
    return;
  }

  // 6. Step the body with the gated drive (locomotion does walk/step-up/fall).
  updateBody(z.body);
}
