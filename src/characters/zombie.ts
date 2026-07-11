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
import { bodiesAdjacent, biteAttack, barrierBetween } from '../game/combat';
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
  ZOMBIE_SIGHT_RADIUS,
  ZOMBIE_SIGHT_BIAS,
  ZOMBIE_SIGHT_PULL_MAX,
  ZOMBIE_ADVANCE_BIAS,
  ZOMBIE_ADVANCE_PULL_MAX,
  ZOMBIE_EMERGE_TICKS,
  BODY_H,
  WANDER_ARRIVE_DIST,
  ATTACK_REACH,
  // NOTE: ZOMBIE_SPAWN_EDGE is no longer imported - the R9 meander rework
  // removed the fixed colony-ward ADVANCE_DIR march (see driveIdle).
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
  // Burrow emergence (playtest R9 "came out of the ground"): while
  // emergeTicks > 0 the zombie is CLAWING UP out of the soil - updateZombie
  // rises the body from its buried start toward emergeTargetY (the standing
  // feet row) and skips all detection/movement/combat/locomotion. 0 = normal.
  emergeTicks: number;
  emergeTargetY: number;
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
  // ...and DOORS are solid to them (v0.10 R8): they gnaw, they don't enter.
  body.undead = true;
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
    emergeTicks: 0,
    emergeTargetY: 0,
  };
}

/**
 * Create a zombie BURIED just below the surface of column x that claws its way
 * up out of the ground (playtest R9 "it'd be cool if they came out of the
 * ground"). `surfaceY` is the topmost body-solid row of the column; the zombie
 * will STAND with its feet at surfaceY - 1 once fully emerged. It starts one
 * full body-height lower (entirely below ground), with clipBelowY set so the
 * renderer hides the still-buried pixels, and rises linearly over
 * ZOMBIE_EMERGE_TICKS. The terrain itself is never modified - the body is not
 * grid matter, so no digging/tunnelling is involved (the no-tunnel invariant
 * concerns locomotion, which is skipped for the whole emergence).
 */
export function createBurrowedZombie(x: number, surfaceY: number): Zombie {
  const targetY = surfaceY - 1; // standing feet row on this column
  const z = createZombie(x, targetY + BODY_H); // start fully below ground
  z.emergeTicks = ZOMBIE_EMERGE_TICKS;
  z.emergeTargetY = targetY;
  z.body.clipBelowY = surfaceY; // hide below-surface pixels at draw time
  z.body.grounded = true;
  z.body.vy = 0;
  return z;
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
  // turned survivor sinks and bottom-walks like any zombie), stops breathing
  // (the drown clock never runs again), and doors bar it (v0.10 R8).
  body.buoyant = false;
  body.breathes = false;
  body.undead = true;
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
    emergeTicks: 0,
    emergeTargetY: 0,
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
 * Sight pull (playtest R9 "meander depending on what they can see"): the
 * horizontal bias a new idle goal receives from the nearest survivor the
 * zombie can SEE within ZOMBIE_SIGHT_RADIUS (further than the SENSE_RADIUS
 * pursuit lock - a distant figure draws a shamble, not a charge). Same
 * capped-and-scaled shape as herdPullX; 0 with nothing in sight. Skips the
 * doomed (infected/prone/turned) exactly like the pursuit detector so a
 * bitten survivor doesn't keep dragging the crowd. Pure, draws no RNG,
 * exported for the r9-zombies test; called only at retarget time.
 */
export function sightPullX(z: Zombie, survivors: readonly Survivor[]): number {
  const bx = z.body.x;
  const by = z.body.y;
  const r2 = ZOMBIE_SIGHT_RADIUS * ZOMBIE_SIGHT_RADIUS;
  let bestDx = 0;
  let bestD = Infinity;
  for (const s of survivors) {
    if (!s.body.alive) continue;
    if (s.body.infected || s.body.prone || s.turned) continue;
    const dx = s.body.x - bx;
    const dy = s.body.y - by;
    const d = dx * dx + dy * dy;
    if (d <= r2 && d < bestD) {
      bestD = d;
      bestDx = dx;
    }
  }
  if (bestD === Infinity) return 0;
  const capped = Math.max(
    -ZOMBIE_SIGHT_PULL_MAX,
    Math.min(ZOMBIE_SIGHT_PULL_MAX, bestDx),
  );
  return capped * ZOMBIE_SIGHT_BIAS;
}

/**
 * Colony-ward pull (playtest fix: "they tend to stay at the left edge of the
 * screen and never leave"). The gentle bias a new idle goal receives toward the
 * colony column `colonyX`. Same capped-and-scaled shape as herdPullX/sightPullX:
 * the signed distance to the colony, clamped to +/-ZOMBIE_ADVANCE_PULL_MAX and
 * scaled by ZOMBIE_ADVANCE_BIAS. Returns 0 when no colony anchor is known
 * (colonyX undefined - headless tests), so a lone zombie with no colony passed
 * meanders exactly as the R9 rework left it. Pulls from EITHER side of the
 * colony (edge and burrow spawns alike) and fades to 0 on arrival. Called only
 * at retarget time (never per tick).
 */
export function colonyPullX(z: Zombie, colonyX: number | undefined): number {
  if (colonyX === undefined) return 0;
  const toColony = colonyX - z.body.x;
  const capped = Math.max(
    -ZOMBIE_ADVANCE_PULL_MAX,
    Math.min(ZOMBIE_ADVANCE_PULL_MAX, toColony),
  );
  return capped * ZOMBIE_ADVANCE_BIAS;
}

/**
 * Idle meander (GDD 7.1 "meander randomly, slow" + playtest R9): pick a goal
 * column near the CURRENT x, shuffle toward it, and repick on a randomised
 * ZOMBIE_IDLE_RETARGET_MIN..MAX timer or on arrival. Sets moveDir only; the
 * speed gate downstream makes the actual drift slow. Never touches the grid or
 * a path - meander is pure local steering.
 *
 * R9 REWORK: the old unconditional colony-ward ADVANCE_DIR march is gone
 * ("rather than wandering in one direction, they should meander around
 * depending on what they can see and other zombies around them"). A goal is
 * now aimless wander +/- ZOMBIE_IDLE_RADIUS, plus the herd pull (follow the
 * crowd), the sight pull (drift toward a visible figure), and a GENTLE
 * colony-ward pull (colonyPullX) so the horde still net-migrates across the map
 * toward the base instead of shuffling in place at the spawn edge forever
 * (the R9 pure-local meander left edge spawns stranded - playtest fix). The
 * colony pull is 0 when no colony anchor is passed, so the meander stays
 * purely local for headless callers.
 */
function driveIdle(
  z: Zombie,
  herd: readonly Zombie[],
  survivors: readonly Survivor[],
  colonyX?: number,
): void {
  const body = z.body;
  const bx = Math.round(body.x);

  // Pick a new goal when none is set or the retarget timer has elapsed.
  if (z.idleGoalX === null || z.idleTicks <= 0) {
    const wander = randInt(-ZOMBIE_IDLE_RADIUS, ZOMBIE_IDLE_RADIUS); // aimless
    const pull = Math.round(herdPullX(z, herd)); // toward nearby allies (0 if alone)
    const sight = Math.round(sightPullX(z, survivors)); // toward a seen figure
    const advance = Math.round(colonyPullX(z, colonyX)); // gentle drift to the colony
    z.idleGoalX = Math.min(
      WORLD_W - 1,
      Math.max(0, bx + wander + pull + sight + advance),
    );
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
  colonyX?: number,
): void {
  // 1. Dead-body guard: a dissolved zombie's cells belong to the sim now.
  if (!z.body.alive) {
    return;
  }

  // 1b. Burrow emergence (playtest R9): a buried zombie spends its first
  //     ZOMBIE_EMERGE_TICKS clawing up out of the soil - the body rises
  //     linearly from its buried start to the standing feet row and does
  //     NOTHING else (no detection, no bite, no locomotion - updateBody would
  //     immediately re-sink/pin a body overlapping ground it isn't standing
  //     on). The renderer clips pixels below clipBelowY, so only the emerged
  //     part shows. On the final tick the clip is dropped and the zombie
  //     stands on the surface, fully live.
  if (z.emergeTicks > 0) {
    z.emergeTicks--;
    const progress = (ZOMBIE_EMERGE_TICKS - z.emergeTicks) / ZOMBIE_EMERGE_TICKS;
    z.body.y = z.emergeTargetY + Math.round(BODY_H * (1 - progress));
    z.body.grounded = true;
    z.body.vy = 0;
    z.body.moveDir = 0;
    if (z.emergeTicks === 0) {
      z.body.y = z.emergeTargetY;
      z.body.clipBelowY = undefined;
    }
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
    driveIdle(z, herd, survivors, colonyX);
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
    bodiesAdjacent(z.body, z.target) &&
    // A barrier (wall/door/fence/hill) between the two anchors blocks the bite
    // (playtest fix: no infecting THROUGH a wall). When barriered we do NOT hold
    // - the zombie keeps pressing so breaching (game/breaching) gnaws the
    // structure down instead of gnawing the survivor on the far side.
    !barrierBetween(z.body, z.target)
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
