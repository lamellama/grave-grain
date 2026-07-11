/**
 * p12-climb — Zombie STACKING (round 11; supersedes the v0.5 #A ally-footing
 * ladder-climb this file used to lock).
 *
 * Real modules, no mocks. A STONE wall 5 cells tall (taller than STEP_UP_MAX=2)
 * sits on a floor with a survivor lure just beyond it. Verifies:
 *   1. STAIRCASE CROSSES — a crowd pressing the wall forms carrier/rider
 *      stacks (the bottom zombie HUNCHED over, the top standing on its back)
 *      and at least one zombie gets over to the far side; a hunched carrier
 *      was observed while ridden and straightens up when its rider leaves.
 *   2. LONE BLOCKED — a single zombie at the same wall (nobody to mount)
 *      never gets over.
 *   3. MAX TWO — at no tick is any zombie simultaneously riding AND ridden,
 *      and no rider's carrier is itself riding (towers cap at two).
 *   4. NO LASTING OVERLAP — any transient landing overlap between unlinked
 *      side-by-side zombies is repaired (sidestep or clamber-over) within a
 *      settle window; a rider legitimately shares its carrier's column,
 *      vertically separated.
 *   5. NO-TUNNEL — across every tick, no zombie body pixel ever occupies a
 *      grid-solid cell.
 */
// ---- seeded RNG (mulberry32): zombie idle wander uses Math.random --------
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
Math.random = mulberry32(4242);

import { createZombie, updateZombie, type Zombie } from '../src/characters/zombie';
import { createSurvivor } from '../src/characters/survivor';
import { material, set, get } from '../src/engine/grid';
import { rebuildNavgrid } from '../src/engine/navgrid';
import { STONE, isSolidForBody } from '../src/engine/materials';
import { WORLD_W, STEP_UP_MAX, BODY_W, BODY_H } from '../src/config';
import { STACK_MIN_GAP } from '../src/characters/zombie';

function fail(msg: string): never {
  console.log('FAIL:', msg);
  throw new Error(msg);
}
function clearGrid() { material.fill(0); }
function floorRow(row: number) { for (let x = 0; x < WORLD_W; x++) set(x, row, STONE); }

// Any body pixel in ANY grid-solid cell (no-tunnel check).
function bodyInSolid(b: any): boolean {
  const rx = Math.round(b.x), ry = Math.round(b.y);
  for (const bone of b.rig) {
    if (bone.destroyed) continue;
    for (const p of bone.pixels) {
      if (isSolidForBody(get(rx + bone.offset.dx + p.dx, ry + bone.offset.dy + p.dy))) return true;
    }
  }
  return false;
}

const FLOOR = 150;       // floor STONE row; bodies rest with feet at FLOOR-1
const WALL_X = 320;      // wall left column
const WALL_W = 3;        // wall width (columns)
const WALL_H = 5;        // wall height (cells) — > STEP_UP_MAX (2): unclimbable solo
const WALL_RIGHT = WALL_X + WALL_W - 1; // wall's rightmost column

function buildScene() {
  clearGrid();
  floorRow(FLOOR);
  // 5-tall wall sitting on the floor: rows FLOOR-WALL_H .. FLOOR-1.
  for (let x = WALL_X; x < WALL_X + WALL_W; x++) {
    for (let y = FLOOR - WALL_H; y <= FLOOR - 1; y++) set(x, y, STONE);
  }
  rebuildNavgrid();
}

// Keep the far-side survivor a permanent valid lure: never updated (stays put),
// and we clear any bite-infection each tick so zombies keep pursuing (and thus
// keep stacking) for the whole run rather than dropping to idle after one bite.
function keepLure(s: any) {
  s.body.infected = false;
  s.body.prone = false;
  s.turned = false;
}

// ====================================================================
// SCENARIO 1 — a crowd stacks (hunched carrier + rider) and crosses.
// ====================================================================
buildScene();
const survivor = createSurvivor(WALL_RIGHT + 14, FLOOR - 1); // far side lure
const zombies: Zombie[] = [];
const SPAWN_N = 6;
for (let i = 0; i < SPAWN_N; i++) {
  // Spawn spread left of the wall, within SENSE_RADIUS of the lure. Spacing
  // >= BODY_W so the no-overlap rule is honoured from tick 0.
  zombies.push(createZombie(WALL_X - 12 - i * (BODY_W + 1), FLOOR - 1));
}

let tunnelTick = -1;
let crossedTick = -1;
let everAttacked = false;
let sawHunchedCarrier = false;
let sawRiderOnBack = false;
let towerOverTwo = false;
const crossedSet = new Set<number>(); // indices of zombies that reached far side

const TICKS = 6000;
for (let t = 0; t < TICKS; t++) {
  keepLure(survivor);
  for (let zi = 0; zi < zombies.length; zi++) {
    const z = zombies[zi];
    updateZombie(z, [survivor], zombies);
    if (z.state === 'attack') everAttacked = true;
    if (bodyInSolid(z.body)) { if (tunnelTick < 0) tunnelTick = t; }
    // Stacking observations (round 11):
    if (z.rider) {
      if (!z.body.hunched) fail(`carrier not hunched while ridden (tick ${t})`);
      sawHunchedCarrier = true;
    }
    if (z.carrier) {
      sawRiderOnBack = true;
      // Rider stands ABOVE its carrier, never inside it.
      if (Math.round(z.body.y) >= Math.round(z.carrier.body.y)) {
        fail(`rider not above its carrier (tick ${t})`);
      }
      // MAX TWO: a rider's carrier may not itself be riding...
      if (z.carrier.carrier) towerOverTwo = true;
    }
    // ...and nobody may ride and carry at once.
    if (z.carrier && z.rider) towerOverTwo = true;
    if (Math.round(z.body.x) > WALL_RIGHT) {
      crossedSet.add(zi);
      if (crossedTick < 0) crossedTick = t;
    }
  }
}

// A carrier whose rider crossed/left must eventually straighten back up.
let lingeringHunch = false;
for (const z of zombies) {
  if (z.body.hunched && !z.rider) lingeringHunch = true;
}

// NO LASTING OVERLAP: a landing can put two bodies together for a moment,
// but the repair (sidestep or clamber-over) must clear every unlinked
// side-by-side deep overlap within a settle window - "they can't overlap".
function anyDeepOverlap(): boolean {
  for (let a = 0; a < zombies.length; a++) {
    for (let b = a + 1; b < zombies.length; b++) {
      const za = zombies[a];
      const zb = zombies[b];
      if (!za.body.alive || !zb.body.alive) continue;
      if (za.carrier === zb || zb.carrier === za) continue; // stacked pair - vertical
      const dx = Math.abs(Math.round(za.body.x) - Math.round(zb.body.x));
      const dy = Math.abs(Math.round(za.body.y) - Math.round(zb.body.y));
      // Side-by-side means feet within a step of each other (the repair's own
      // definition) - a rider is ~HUNCHED_HEIGHT above and never side-by-side.
      if (dy <= STEP_UP_MAX + 1 && dx < STACK_MIN_GAP) return true;
    }
  }
  return false;
}
let overlapped = anyDeepOverlap();
for (let t = 0; t < 600 && overlapped; t++) {
  keepLure(survivor);
  for (const z of zombies) updateZombie(z, [survivor], zombies);
  overlapped = anyDeepOverlap();
}

const crossedCount = crossedSet.size;
console.log('S1 staircase:',
  'zombies', SPAWN_N,
  'everAttacked', everAttacked,
  'crossedToFarSide', crossedCount,
  'firstCrossTick', crossedTick,
  'sawHunchedCarrier', sawHunchedCarrier,
  'sawRiderOnBack', sawRiderOnBack,
  'towerOverTwo', towerOverTwo,
  'lastingOverlap', overlapped,
  'lingeringHunch', lingeringHunch,
  'tunnel', tunnelTick >= 0 ? 'tick ' + tunnelTick : 'none');
const S1_PASS =
  everAttacked &&
  crossedSet.size >= 1 &&
  sawHunchedCarrier &&
  sawRiderOnBack &&
  !towerOverTwo &&
  !overlapped &&
  tunnelTick < 0;
console.log('S1 PASS staircase crosses + hunched carrier + max-two + no overlap + no-tunnel:', S1_PASS);

// ====================================================================
// SCENARIO 2 — a LONE zombie at the same wall never gets over.
// ====================================================================
buildScene();
const survivor2 = createSurvivor(WALL_RIGHT + 14, FLOOR - 1);
const lone = createZombie(WALL_X - 12, FLOOR - 1);
let loneTunnel = false;
let loneMaxX = Math.round(lone.body.x);
let loneMinY = Math.round(lone.body.y);
let loneAttacked = false;
for (let t = 0; t < TICKS; t++) {
  keepLure(survivor2);
  updateZombie(lone, [survivor2], [lone]);
  if (lone.state === 'attack') loneAttacked = true;
  if (bodyInSolid(lone.body)) loneTunnel = true;
  loneMaxX = Math.max(loneMaxX, Math.round(lone.body.x));
  loneMinY = Math.min(loneMinY, Math.round(lone.body.y));
}
const loneCrossed = loneMaxX > WALL_RIGHT;
// A lone zombie may step up at most STEP_UP_MAX onto nothing here; it should
// stay essentially at floor level (feet never rise above STEP_UP_MAX).
const loneRose = loneMinY < (FLOOR - 1) - STEP_UP_MAX;
console.log('S2 lone:',
  'attacked', loneAttacked,
  'maxX', loneMaxX, '(wallRight=' + WALL_RIGHT + ')',
  'crossed', loneCrossed,
  'minY', loneMinY, 'roseAboveStepUp', loneRose,
  'tunnel', loneTunnel);
const S2_PASS = loneAttacked && !loneCrossed && !loneRose && !loneTunnel;
console.log('S2 PASS lone zombie blocked (nobody to mount):', S2_PASS);

// ====================================================================
console.log('\nSUMMARY S1', S1_PASS, 'S2', S2_PASS);
if (!S1_PASS) fail('staircase did not form/cross cleanly');
if (!S2_PASS) fail('lone zombie climbed/tunnelled when it should be blocked');
if (lingeringHunch) fail('a carrier stayed hunched after its rider left');
console.log('ALL PASS');
