declare const process: any;
/**
 * test/zombie-ai-fixes.test.ts - Playtest fixes for four reported zombie-AI /
 * survival bugs. Headless Node test over the REAL modules (grid, navgrid,
 * locomotion, zombie/survivor controllers, combat, infection, pathfinding).
 * Math.random is stubbed with a seeded LCG (body/AI-layer RNG only). tsc -> node.
 *
 *  1. FLEE ZOMBIES - a non-guard survivor with a zombie in range steers AWAY;
 *     an armed guard does NOT flee (it holds/engages).
 *  2. NO BITE THROUGH A BARRIER - a zombie separated from its target by a WALL
 *     is "adjacent" by distance yet never infects it (barrierBetween); with no
 *     wall the same setup DOES infect.
 *  3. COLONY-WARD DRIFT - a lone idle zombie given a colony column net-migrates
 *     toward it over time, while the same zombie with NO colony passed stays
 *     local (preserving the R9 pure-local meander).
 *  4. DIE-FIRST TURNING - an infected survivor DIES (alive=false, corpse) at
 *     INFECTION_DEATH_TICKS, then REANIMATES (alive=true) at TURN_DELAY_TICKS;
 *     dissolving the twitching corpse before the turn stops the rise.
 *  5. PATHFIND CAP - a path to an unreachable goal returns null (bounded), while
 *     a reachable goal still returns a valid route.
 */

import {
  createZombie,
  updateZombie,
} from '../src/characters/zombie';
import { createSurvivor, updateSurvivor, assignRole } from '../src/characters/survivor';
import { updateInfection } from '../src/characters/infection';
import { biteAttack, barrierBetween, bodiesAdjacent } from '../src/game/combat';
import { applyDamage } from '../src/characters/damage';
import { makeTool } from '../src/game/roles';
import { findPath } from '../src/game/pathfinding';
import { material, set } from '../src/engine/grid';
import { rebuildNavgrid, markTerrainEdit } from '../src/engine/navgrid';
import { STONE, WALL } from '../src/engine/materials';
import {
  WORLD_W,
  INFECTION_ACTING_TICKS,
  INFECTION_DEATH_TICKS,
  TURN_DELAY_TICKS,
  ZOMBIE_FLEE_RADIUS,
  BODY_H,
} from '../src/config';

let failures = 0;
function check(cond: boolean, msg: string): void {
  console.log((cond ? 'PASS: ' : 'FAIL: ') + msg);
  if (!cond) failures++;
}
function seedRandom(seed: number): void {
  let s = seed >>> 0;
  Math.random = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const FLOOR = 150;
function flatWorld(): void {
  material.fill(0);
  for (let x = 0; x < WORLD_W; x++) set(x, FLOOR, STONE);
  rebuildNavgrid();
}

// ===========================================================================
// 1. FLEE ZOMBIES
// ===========================================================================
console.log('\n[1] survivors flee zombies');
{
  flatWorld();
  seedRandom(1);
  // Survivor at 400, zombie a few cells to the RIGHT and inside flee range.
  const s = createSurvivor(400, FLOOR - 1);
  const z = createZombie(400 + ZOMBIE_FLEE_RADIUS - 8, FLOOR - 1);
  updateSurvivor(s, [z]);
  check(s.behaviour === 'fleeZombie', 'flee: survivor with a nearby zombie enters fleeZombie');
  check(s.body.moveDir === -1, 'flee: steers AWAY from the zombie (to the left)');

  // Same setup but the zombie is far outside flee range -> no flee.
  const s2 = createSurvivor(400, FLOOR - 1);
  const zFar = createZombie(400 + ZOMBIE_FLEE_RADIUS + 40, FLOOR - 1);
  updateSurvivor(s2, [zFar]);
  check(s2.behaviour !== 'fleeZombie', 'flee: a distant zombie does not trigger fleeZombie');

  // An ARMED GUARD does not flee - it holds/engages instead.
  const g = createSurvivor(400, FLOOR - 1);
  g.tool = makeTool('weapon');
  assignRole(g, 'guard');
  const zg = createZombie(400 + ZOMBIE_FLEE_RADIUS - 8, FLOOR - 1);
  updateSurvivor(g, [zg]);
  check(g.behaviour !== 'fleeZombie', 'flee: an armed guard never flees (engages)');
}

// ===========================================================================
// 2. NO BITE THROUGH A BARRIER
// ===========================================================================
console.log('\n[2] no infecting through a wall');
{
  flatWorld();
  seedRandom(2);
  // Place two bodies close enough to be "adjacent" (distance), with a WALL
  // column standing between them.
  const zx = 400;
  const sx = 406; // within reach + BODY_W of the zombie anchor
  // A full-height wall column at the midpoint.
  const wallX = 403;
  for (let dy = 1; dy <= BODY_H; dy++) set(wallX, FLOOR - dy, WALL);
  markTerrainEdit(wallX, FLOOR - 1);
  rebuildNavgrid();

  const z = createZombie(zx, FLOOR - 1);
  const prey = createSurvivor(sx, FLOOR - 1);
  check(bodiesAdjacent(z.body, prey.body), 'barrier: bodies register as adjacent by distance');
  check(barrierBetween(z.body, prey.body), 'barrier: a wall is detected between the anchors');

  // Drive the zombie for a while: it locks on but must NEVER infect through the wall.
  z.state = 'attack';
  z.target = prey.body;
  let infected = false;
  for (let t = 0; t < 400 && !infected; t++) {
    updateZombie(z, [prey], [z]);
    if (prey.body.infected) infected = true;
  }
  check(!prey.body.infected, 'barrier: zombie never bites the survivor through the wall');

  // Remove the wall -> the same adjacency now DOES infect.
  flatWorld();
  seedRandom(2);
  const z2 = createZombie(zx, FLOOR - 1);
  const prey2 = createSurvivor(sx, FLOOR - 1);
  check(!barrierBetween(z2.body, prey2.body), 'barrier: no wall -> no barrier');
  z2.state = 'attack';
  z2.target = prey2.body;
  let infected2 = false;
  for (let t = 0; t < 400 && !infected2; t++) {
    updateZombie(z2, [prey2], [z2]);
    if (prey2.body.infected) infected2 = true;
  }
  check(prey2.body.infected, 'barrier: with no wall the zombie DOES infect (sanity)');
}

// ===========================================================================
// 3. COLONY-WARD DRIFT
// ===========================================================================
console.log('\n[3] idle zombies drift toward the colony');
{
  flatWorld();
  seedRandom(7);
  // Colony far to the RIGHT of a zombie spawned near the left edge.
  const colonyX = 900;
  const z = createZombie(120, FLOOR - 1);
  const startX = z.body.x;
  for (let t = 0; t < 4000; t++) updateZombie(z, [], [z], colonyX);
  const advanced = z.body.x - startX;
  console.log('  colony-ward drift over 4000t:', Math.round(advanced), 'cells');
  check(advanced > 120, 'drift: lone idle zombie net-migrates toward the colony');
  check(z.body.x < colonyX + 20, 'drift: it does not overshoot far past the colony');

  // With NO colony passed, the same zombie stays local (R9 pure meander).
  flatWorld();
  seedRandom(7);
  const z2 = createZombie(120, FLOOR - 1);
  for (let t = 0; t < 4000; t++) updateZombie(z2, [], [z2]);
  check(Math.abs(z2.body.x - 120) < 100, 'drift: no colony anchor -> stays local (unchanged R9)');
}

// ===========================================================================
// 4. DIE-FIRST TURNING
// ===========================================================================
console.log('\n[4] infected survivors die first, then reanimate');
{
  flatWorld();
  seedRandom(3);
  const s = createSurvivor(300, FLOOR - 1);
  const horde: any[] = [];
  biteAttack(s.body);

  // Acting phase: still alive, not prone, not a corpse.
  updateInfection([s], horde, 1);
  check(s.body.alive && !s.body.prone && !s.body.corpse, 'turn: acts while alive early');

  // Drop prone at INFECTION_ACTING_TICKS, still ALIVE.
  for (let t = 2; t <= INFECTION_ACTING_TICKS; t++) updateInfection([s], horde, t);
  check(s.body.alive && s.body.prone, 'turn: prone/downed at INFECTION_ACTING_TICKS (still alive)');

  // DIE at INFECTION_DEATH_TICKS: alive=false, corpse, flagged reanimating, not yet turned.
  for (let t = INFECTION_ACTING_TICKS + 1; t <= INFECTION_DEATH_TICKS; t++) updateInfection([s], horde, t);
  check(!s.body.alive && s.body.corpse, 'turn: DIES to a corpse at INFECTION_DEATH_TICKS');
  check(s.body.reanimating && !s.turned && horde.length === 0, 'turn: dead corpse flagged to reanimate, not yet risen');

  // REANIMATE at TURN_DELAY_TICKS: back to life, no longer a corpse, turned.
  for (let t = INFECTION_DEATH_TICKS + 1; t <= TURN_DELAY_TICKS; t++) updateInfection([s], horde, t);
  check(s.turned && horde.length === 1, 'turn: reanimates as a zombie at TURN_DELAY_TICKS');
  check(s.body.alive && !s.body.corpse && !s.body.reanimating, 'turn: comes back to LIFE (alive, not corpse)');
  check(horde[0].body === s.body, 'turn: reanimated zombie reuses the SAME body');

  // Counterplay: dissolving the twitching CORPSE (after death, before turn) stops the rise.
  flatWorld();
  seedRandom(4);
  const v = createSurvivor(300, FLOOR - 1);
  const horde2: any[] = [];
  biteAttack(v.body);
  for (let t = 1; t <= INFECTION_DEATH_TICKS; t++) updateInfection([v], horde2, t);
  check(!v.body.alive && v.body.reanimating, 'counterplay: victim is a reanimating corpse');
  applyDamage(v.body, 'head'); // headshot the corpse
  check(!v.body.reanimating, 'counterplay: dissolving the corpse clears the reanimation flag');
  for (let t = INFECTION_DEATH_TICKS + 1; t <= TURN_DELAY_TICKS + 10; t++) updateInfection([v], horde2, t);
  check(horde2.length === 0 && !v.turned, 'counterplay: a dissolved corpse never rises');
}

// ===========================================================================
// 5. PATHFIND CAP (bounded unreachable search)
// ===========================================================================
console.log('\n[5] pathfinding is bounded and correct');
{
  flatWorld();
  // Reachable: same flat floor, start->goal returns a real route.
  const ok = findPath(100, FLOOR - 1, 500, FLOOR - 1);
  check(ok !== null && ok.waypoints.length > 0, 'path: reachable goal returns a route');

  // Unreachable: wall off a pocket the goal sits in with a full-height barrier
  // spanning the world height, so no route exists -> null (and bounded, no hang).
  material.fill(0);
  for (let x = 0; x < WORLD_W; x++) set(x, FLOOR, STONE);
  // A full-height wall band WIDER than a coarse cell (NAV_CELL) so the whole
  // coarse column is unwalkable and the two sides are genuinely disconnected.
  for (let bx = 296; bx <= 315; bx++) {
    for (let y = 0; y <= FLOOR; y++) set(bx, y, STONE);
  }
  rebuildNavgrid();
  const none = findPath(100, FLOOR - 1, 600, FLOOR - 1);
  check(none === null, 'path: goal sealed behind a full barrier is unreachable (null, bounded)');
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
if (failures > 0) process.exit(1);
