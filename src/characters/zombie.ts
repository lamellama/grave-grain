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
import { createBody, setHunched, HUNCHED_HEIGHT } from './body';
import { updateBody, bodyCellsSolidAt } from './locomotion';
import type { Survivor } from './survivor';
import type { Path } from '../game/pathfinding';
import { findPath, isPathStale } from '../game/pathfinding';
import { bodiesAdjacent, biteAttack, barrierBetween } from '../game/combat';
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
  BODY_W,
  WANDER_ARRIVE_DIST,
  ATTACK_REACH,
  // NOTE: ZOMBIE_SPAWN_EDGE is no longer imported - the R9 meander rework
  // removed the fixed colony-ward ADVANCE_DIR march (see driveIdle).
  PATH_REPATH_COOLDOWN,
  WALK_SPEED,
  WORLD_W,
  STEP_UP_MAX,
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
  // Round 11 zombie STACKING ("moved over each other, not overlapping"):
  //   carrier - the zombie THIS one is standing on (its feet ride the
  //             carrier's hunched back), or null when on the ground.
  //   rider   - the zombie standing on THIS one's back (the carrier is
  //             hunched over and holds still as a step), or null.
  // A carrier is always itself ground-standing (a rider can never be mounted
  // - max tower is TWO), so 3+ zombies at a wall form a STAIRCASE: hunched
  // carrier + rider at the face, the rest queueing behind at ground level.
  carrier: Zombie | null;
  rider: Zombie | null;
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
    carrier: null,
    rider: null,
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
    carrier: null,
    rider: null,
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
// Zombie STACKING (round 11; replaces the v0.5 #A ally-footing ladder-climb).
//
// "They can't overlap, but when a zombie is on top of another zombie, the
// bottom one should be hunched over. A zombie can't climb on top of a zombie
// on another zombie, but they can create a kind of zombie staircase when
// there are 3 or more."
//
// The model is EXPLICIT carrier/rider links instead of ghost-overlap piles:
//   - Walkers never overlap: a zombie whose next step would push it into
//     another zombie's space QUEUES behind it (blockedByAlly).
//   - A blocked attacker MOUNTS the ally in front of it instead: it steps up
//     onto the ally's back (tryMount), the ally HUNCHES OVER (setHunched -
//     the visible tell) and holds still as a living step. Max tower = TWO:
//     a rider can never be mounted and a carrier can never ride.
//   - With 3+ zombies the crowd forms a STAIRCASE at the wall: hunched
//     carrier + rider at the face (gnawing high), the rest queueing at ground
//     level behind - and once the rider can clear the top (normal step-up
//     from its raised feet) it dismounts over the wall and the next queuer
//     mounts in its place.
// ADDITIVE over the shared GATE locomotion: updateBody is never changed; a
// carried/carrying zombie simply skips it for the hold. No-tunnel holds: every
// mount position is grid-clear (bodyCellsSolidAt) before it is taken.
// ===========================================================================

/** Feet row of a rider standing on a carrier's hunched back, relative to the
 *  carrier's own feet row (see body.HUNCHED_HEIGHT). */
const STACK_RIDE_DY = HUNCHED_HEIGHT;

/** Minimum horizontal anchor gap (cells) between two unlinked same-level
 *  zombies before the deep-overlap repair stops pushing them apart. */
export const STACK_MIN_GAP = 3;

/** Would a normal walk/step-up (1..STEP_UP_MAX) succeed in direction `step`? */
function normalStepClear(body: Body, step: 1 | -1): boolean {
  if (!bodyCellsSolidAt(body, step, 0)) return true;
  for (let h = 1; h <= STEP_UP_MAX; h++) {
    if (!bodyCellsSolidAt(body, step, -h)) return true;
  }
  return false;
}

/** Unlink a carrier/rider pair from the CARRIER side and straighten it up. */
function dropRider(c: Zombie): void {
  if (c.rider && c.rider.carrier === c) c.rider.carrier = null;
  c.rider = null;
  setHunched(c.body, false);
}

/** Unlink a carrier/rider pair from the RIDER side. */
function dismount(r: Zombie): void {
  const c = r.carrier;
  r.carrier = null;
  if (c && c.rider === r) {
    c.rider = null;
    setHunched(c.body, false);
  }
}

/**
 * Is another live, non-emerging zombie occupying the space one step toward
 * `step` (round 11 "they can't overlap")? Two zombies at the same level within
 * a body width of each other may not close the gap further - the follower
 * queues. Moves that OPEN the gap are always allowed so an accidentally
 * overlapped pair (e.g. a burrow spawn) can separate. Stack partners are
 * exempt (a rider legitimately shares its carrier's column).
 */
function blockedByAlly(z: Zombie, step: 1 | -1, herd: readonly Zombie[]): Zombie | null {
  const body = z.body;
  const x = Math.round(body.x);
  const y = Math.round(body.y);
  for (const o of herd) {
    if (o === z || !o.body.alive || o.emergeTicks > 0) continue;
    if (o === z.carrier || o === z.rider) continue;
    const ox = Math.round(o.body.x);
    const oy = Math.round(o.body.y);
    // Same TIER only (feet within a step): walkers on the flat queue behind
    // each other; a zombie up on a wall/back descending past a ground zombie
    // is a different tier and passes (it lands and the deep-overlap repair
    // staggers them) - blocking across tiers gridlocked wall crossings.
    if (Math.abs(oy - y) > STEP_UP_MAX + 1) continue;
    const cur = Math.abs(ox - x);
    const next = Math.abs(ox - (x + step));
    if (next < BODY_W && next < cur) return o; // would close in -> blocked
  }
  return null;
}

/**
 * Try to MOUNT `c` (the ally blocking us): step up onto its back, hunching it
 * over. Requirements (round 11):
 *   - c stands on REAL ground (a rider can never be mounted - max tower 2)
 *     and carries nobody yet;
 *   - the raised position is grid-clear (no-tunnel is non-negotiable) and no
 *     third zombie already overlaps it;
 *   - we only mount on a tick the speed gate released a step (the caller
 *     checks moveDir), so the climb cadence matches the walk.
 * On success the climber is placed feet-on-back and the pair is linked.
 */
function tryMount(z: Zombie, c: Zombie, herd: readonly Zombie[]): boolean {
  if (!ZOMBIE_CLIMB_ENABLED) return false;
  const body = z.body;
  if (z.rider) return false; // someone is standing on US - we hold for them
  if (c.rider || c.carrier) return false; // occupied, or itself riding (max 2)
  if (!c.body.alive || c.emergeTicks > 0) return false;
  if (!bodyCellsSolidAt(c.body, 0, 1)) return false; // carrier must stand on grid

  const mx = Math.round(c.body.x);
  const my = Math.round(c.body.y) - STACK_RIDE_DY;
  const dx = mx - Math.round(body.x);
  const dy = my - Math.round(body.y);
  if (bodyCellsSolidAt(body, dx, dy)) return false; // raised spot inside terrain

  // A third zombie already up there (e.g. mid-dismount)? Then the spot is taken.
  for (const o of herd) {
    if (o === z || o === c || !o.body.alive || o.emergeTicks > 0) continue;
    if (
      Math.abs(Math.round(o.body.x) - mx) < BODY_W - 1 &&
      Math.abs(Math.round(o.body.y) - my) < BODY_H - 2
    ) {
      return false;
    }
  }

  body.x = mx;
  body.y = my;
  body.grounded = true;
  body.vy = 0;
  z.carrier = c;
  c.rider = z;
  setHunched(c.body, true);
  return true;
}

/**
 * Per-tick stacking pass for one zombie (round 11). Returns true iff it HANDLED
 * the zombie's locomotion this tick (carrying/riding hold, or a fresh mount) -
 * the caller must then SKIP updateBody. Returns false to defer to the normal
 * shared locomotion, including the rider's dismount step over the wall top.
 */
function zombieStackTick(z: Zombie, herd: readonly Zombie[]): boolean {
  const body = z.body;

  // --- CARRYING: hunch over and hold still as a living step. -----------------
  if (z.rider) {
    if (!z.rider.body.alive || z.rider.carrier !== z) {
      dropRider(z); // rider died/left - straighten up and resume next tick
    } else {
      setHunched(body, true);
      body.moveDir = 0;
      body.grounded = true;
      body.vy = 0;
      return true; // hold (still gnaws - breaching reads state+facing)
    }
  }

  // --- RIDING: feet pinned to the carrier's back. -----------------------------
  if (z.carrier) {
    const c = z.carrier;
    if (!c.body.alive || c.rider !== z || !c.body.hunched) {
      dismount(z);
      return false; // lost the step - normal locomotion takes over (falls)
    }
    body.x = c.body.x;
    body.y = Math.round(c.body.y) - STACK_RIDE_DY;
    body.grounded = true;
    body.vy = 0;
    // Can we clear the obstacle from up here? Step OFF the back and over.
    if (body.moveDir !== 0 && normalStepClear(body, body.moveDir as 1 | -1)) {
      dismount(z);
      return false; // updateBody walks/steps off the back this tick
    }
    return true; // hold on the back (gnawing the high rows)
  }

  // --- DEEP OVERLAP repair: step away until visibly separated. ---------------
  // Landings (a rider dropping off the far side of a wall onto a queued ally)
  // and burrow spawns can still put two bodies on top of each other; walkers
  // themselves never close in (blockedByAlly). Whoever finds itself deeply
  // overlapped sidesteps until the pair is at least STACK_MIN_GAP apart -
  // "they can't overlap". A direction is usable when the terrain allows the
  // step AND it doesn't shove us deep into a THIRD same-tier zombie.
  {
    const x = Math.round(body.x);
    const y = Math.round(body.y);
    const stepOk = (dir: 1 | -1): boolean => {
      if (!normalStepClear(body, dir)) return false;
      for (const o of herd) {
        if (o === z || !o.body.alive || o.emergeTicks > 0) continue;
        if (o === z.carrier || o === z.rider) continue;
        const ox = Math.round(o.body.x);
        const oy = Math.round(o.body.y);
        if (Math.abs(oy - y) > STEP_UP_MAX + 1) continue;
        const cur = Math.abs(ox - x);
        const next = Math.abs(ox - (x + dir));
        if (next < STACK_MIN_GAP && next < cur) return false; // rams a third body
      }
      return true;
    };
    for (const o of herd) {
      if (o === z || !o.body.alive || o.emergeTicks > 0) continue;
      if (o === z.carrier || o === z.rider) continue;
      const ox = Math.round(o.body.x);
      const oy = Math.round(o.body.y);
      // Truly side-by-side only (feet within a step): a rider stepping off a
      // back sits ~HUNCHED_HEIGHT above its old carrier and must NOT be
      // shoved backward off the wall by this repair.
      if (Math.abs(oy - y) > STEP_UP_MAX + 1) continue;
      if (Math.abs(ox - x) >= STACK_MIN_GAP) continue;
      // Perfectly coincident pairs need a SYMMETRY BREAKER or they sidestep
      // in lockstep forever: split by herd-list parity (stable, RNG-free).
      const away: 1 | -1 =
        x < ox ? -1 : x > ox ? 1 : (herd.indexOf(z) & 1) === 0 ? -1 : 1;
      const dir = stepOk(away) ? away : stepOk(-away as 1 | -1) ? (-away as 1 | -1) : 0;
      if (dir !== 0) {
        body.moveDir = dir; // updateBody walks the separation step
        return false;
      }
      // Hemmed in on both sides (wall on one flank, crowd on the other): an
      // attacker CLAMBERS ONTO the body it overlaps instead - zombies move
      // OVER each other, they never share a space.
      if (z.state === 'attack' && tryMount(z, o, herd)) return true;
      break; // truly stuck this tick - try again next
    }
  }

  // --- WALKING: never overlap - queue, or mount the ally in the way. ---------
  if (body.moveDir !== 0) {
    const step = body.moveDir as 1 | -1;
    const inWay = blockedByAlly(z, step, herd);
    if (inWay) {
      // An attacker blocked at the crowd climbs onto the ally's back instead.
      if (z.state === 'attack' && tryMount(z, inWay, herd)) return true;
      body.moveDir = 0; // queue behind - no ghost overlap
      return false;
    }
  }

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

  // 5b. Stacking (round 11): carrier/rider holds, no-overlap queueing, and a
  //     blocked attacker mounting the ally in front of it (the hunched-carrier
  //     staircase). If it handled locomotion this tick, skip updateBody so the
  //     fall doesn't drop a held zombie off its perch.
  if (zombieStackTick(z, herd)) {
    return;
  }

  // 6. Step the body with the gated drive (locomotion does walk/step-up/fall).
  updateBody(z.body);
}
