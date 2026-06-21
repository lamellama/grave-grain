/**
 * p12-climb — Zombie ladder-climb (post-MVP backlog, playtest v0.5 #A).
 *
 * Real modules, no mocks. A STONE wall 5 cells tall (taller than STEP_UP_MAX=2)
 * sits on a floor with a survivor lure just beyond it. Verifies:
 *   1. PILE CLIMBS  — a crowd of zombies pressing the wall piles up and at least
 *      one climbs over to the far side / above the wall top.
 *   2. LONE BLOCKED — a single zombie at the same wall (no ally footing) never
 *      gets over.
 *   3. NO-TUNNEL    — across every tick of every run, no zombie body pixel ever
 *      occupies a STONE (grid-solid) cell (overlapping ally sprites is allowed).
 */
import { createZombie, updateZombie, type Zombie } from '../src/characters/zombie';
import { createSurvivor } from '../src/characters/survivor';
import { rebuildZombieFooting } from '../src/characters/zombieFooting';
import { material, set, get } from '../src/engine/grid';
import { rebuildNavgrid } from '../src/engine/navgrid';
import { STONE, isSolidForBody } from '../src/engine/materials';
import { WORLD_W, STEP_UP_MAX } from '../src/config';

function fail(msg: string): never {
  console.log('FAIL:', msg);
  throw new Error(msg);
}
function clearGrid() { material.fill(0); }
function floorRow(row: number) { for (let x = 0; x < WORLD_W; x++) set(x, row, STONE); }

// Any non-destroyed body pixel currently sitting in a STONE cell? (no-tunnel)
function bodyInStone(b: any): boolean {
  const rx = Math.round(b.x), ry = Math.round(b.y);
  for (const bone of b.rig) {
    if (bone.destroyed) continue;
    for (const p of bone.pixels) {
      if (get(rx + bone.offset.dx + p.dx, ry + bone.offset.dy + p.dy) === STONE) return true;
    }
  }
  return false;
}
// Any body pixel in ANY grid-solid cell (broader no-tunnel check).
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
const WALL_TOP = FLOOR - WALL_H;        // wall top solid row (FLOOR-5)

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
// keep climbing) for the whole run rather than dropping to idle after one bite.
function keepLure(s: any) {
  s.body.infected = false;
  s.body.prone = false;
  s.turned = false;
}

// ====================================================================
// SCENARIO 1 — a crowd piles and climbs over the wall.
// ====================================================================
// Lure sits well clear of the wall so zombies don't register melee-adjacency
// THROUGH the wall (bodiesAdjacent ignores terrain) and stop to bite instead of
// climbing — but still within SENSE_RADIUS so the crowd stays in pursuit/attack.
buildScene();
const survivor = createSurvivor(WALL_RIGHT + 14, FLOOR - 1); // far side lure
const zombies: Zombie[] = [];
const SPAWN_N = 6;
for (let i = 0; i < SPAWN_N; i++) {
  // Spawn clustered just left of the wall, well within SENSE_RADIUS of the lure.
  zombies.push(createZombie(WALL_X - 12 - i, FLOOR - 1));
}

let tunnelTick = -1;
let crossedTick = -1;
let everAttacked = false;
let minY = Infinity;       // highest any zombie rose (smaller y = higher)
const crossedSet = new Set<number>(); // indices of zombies that reached far side

const TICKS = 5000;
for (let t = 0; t < TICKS; t++) {
  keepLure(survivor);
  rebuildZombieFooting(zombies);
  for (let zi = 0; zi < zombies.length; zi++) {
    const z = zombies[zi];
    updateZombie(z, [survivor]);
    if (z.state === 'attack') everAttacked = true;
    if (bodyInSolid(z.body)) { if (tunnelTick < 0) tunnelTick = t; }
    minY = Math.min(minY, Math.round(z.body.y));
    if (Math.round(z.body.x) > WALL_RIGHT) {
      crossedSet.add(zi);
      if (crossedTick < 0) crossedTick = t;
    }
  }
}

const crossedCount = crossedSet.size;
const roseAboveTop = minY <= WALL_TOP; // any zombie's feet reached/above wall top
console.log('S1 crowd-climb:',
  'zombies', SPAWN_N,
  'everAttacked', everAttacked,
  'crossedToFarSide', crossedCount,
  'firstCrossTick', crossedTick,
  'minY', minY, '(wallTop=' + WALL_TOP + ', floorFeet=' + (FLOOR - 1) + ')',
  'roseAboveWallTop', roseAboveTop,
  'tunnel', tunnelTick >= 0 ? 'tick ' + tunnelTick : 'none');
const S1_PASS = everAttacked && (crossedCount >= 1 || roseAboveTop) && tunnelTick < 0;
console.log('S1 PASS pile climbs over + no-tunnel:', S1_PASS);

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
  rebuildZombieFooting([lone]);
  updateZombie(lone, [survivor2]);
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
console.log('S2 PASS lone zombie blocked (no climb without allies):', S2_PASS);

// ====================================================================
console.log('\nSUMMARY S1', S1_PASS, 'S2', S2_PASS);
if (!S1_PASS) fail('pile did not climb the wall (or tunnelled)');
if (!S2_PASS) fail('lone zombie climbed/tunnelled when it should be blocked');
console.log('ALL PASS');
