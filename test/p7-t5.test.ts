/**
 * p7-t5.test.ts — Structure breaching (GDD §7.4), real modules, headless.
 *
 * Scene: a 1-cell-wide vertical WOOD fence (each cell integrity=WOOD_INTEGRITY)
 * stands on a STONE floor between a zombie (left, facing right, attack-state) and
 * a target survivor (right, beyond the fence, in sense range). Each tick we
 * updateZombie (so it keeps pressing) then resolveBreaching.
 *
 * Verifies:
 *   B1 — 1 zombie: the pressed cell's integrity DECREASES over time and the cell
 *        eventually becomes AIR + markTerrainEdit fired (coarse epoch bumped).
 *   B2 — PRESSURE: 4 zombies pressing the SAME cell breach it in MATERIALLY
 *        fewer ticks than 1 (averaged over seeded runs).
 *   B3 — a cell with NO integrity (raw STONE, hasIntegrity=false) is NEVER
 *        chipped or destroyed by breaching.
 *
 * RNG is seeded (Math.random override) so the reported numbers are reproducible.
 */

import { createZombie, updateZombie } from '../src/characters/zombie';
import { createSurvivor } from '../src/characters/survivor';
import {
  resolveBreaching,
  findBlockingStructureCell,
} from '../src/game/breaching';
import { material, set, get, getIntegrity, placeMaterial } from '../src/engine/grid';
import { rebuildNavgrid, epochAt, coarseOf } from '../src/engine/navgrid';
import { STONE, WOOD, AIR } from '../src/engine/materials';
import { WORLD_W, WOOD_INTEGRITY } from '../src/config';

// --- seeded RNG (mulberry32) so reported tick counts are deterministic --------
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
function seedRandom(seed: number): void {
  const rng = mulberry32(seed);
  Math.random = rng;
}

const FLOOR = 150;
const FENCE_X = 320;
const FENCE_TOP = FLOOR - 16; // 16 tall — taller than the body, no step-over

/** Build the fence scene with `n` zombies stacked against the fence. */
function buildScene(n: number, mat: number) {
  material.fill(0);
  for (let x = 0; x < WORLD_W; x++) set(x, FLOOR, STONE);
  for (let y = FENCE_TOP; y <= FLOOR - 1; y++) placeMaterial(FENCE_X, y, mat);
  rebuildNavgrid();
  // rightmost body pixel = round(x)+2; placing x = FENCE_X-3 makes that pixel
  // land at FENCE_X-1, so the body is flush against the fence from tick 1.
  const zombies = [];
  for (let i = 0; i < n; i++) zombies.push(createZombie(FENCE_X - 3, FLOOR - 1));
  // Target beyond the fence, inside SENSE_RADIUS but well out of melee reach so
  // the zombie keeps pressing the wall instead of striking the survivor.
  const target = createSurvivor(FENCE_X + 10, FLOOR - 1);
  return { zombies, target };
}

/** Run the scene until the pressed cell is destroyed; return diagnostics. */
function runToBreach(n: number, mat: number, maxTicks: number) {
  const { zombies, target } = buildScene(n, mat);
  const cell = findBlockingStructureCell(zombies[0].body, 1);
  if (!cell) return { tick: -1, cell: null, epBefore: 0, epAfter: 0, minInteg: -1 };
  const { cx, cy } = coarseOf(cell.x, cell.y);
  const epBefore = epochAt(cx, cy);
  let minInteg = getIntegrity(cell.x, cell.y);
  for (let t = 1; t <= maxTicks; t++) {
    for (const z of zombies) updateZombie(z, [target]);
    resolveBreaching(zombies);
    const integ = getIntegrity(cell.x, cell.y);
    if (get(cell.x, cell.y) !== AIR && integ < minInteg) minInteg = integ;
    if (get(cell.x, cell.y) === AIR) {
      return { tick: t, cell, epBefore, epAfter: epochAt(cx, cy), minInteg };
    }
  }
  return { tick: -1, cell, epBefore, epAfter: epochAt(cx, cy), minInteg };
}

// =====================================================================
// B1 — 1 zombie chips a WOOD fence cell down to AIR; epoch bumps.
// =====================================================================
seedRandom(1);
const b1 = runToBreach(1, WOOD, 5000);
const b1Pass =
  b1.cell !== null &&
  getIntegrity(b1.cell.x, b1.cell.y) === 0 && // setIntegrity hit 0
  b1.tick > 0 &&
  b1.epAfter > b1.epBefore; // markTerrainEdit fired
console.log(
  'B1 pressed cell', b1.cell,
  'baseInteg', WOOD_INTEGRITY,
  'ticks-to-breach (n=1)', b1.tick,
  'epoch', b1.epBefore, '→', b1.epAfter,
);
console.log('B1 PASS integrity→0, cell→AIR, navgrid epoch bumped:', b1Pass);

// =====================================================================
// B2 — PRESSURE: 4 zombies breach materially faster than 1 (seeded avg).
// =====================================================================
const SEEDS = [11, 22, 33, 44, 55, 66, 77, 88, 99, 101, 202, 303];
function avgTicks(n: number): number {
  let sum = 0;
  for (const s of SEEDS) {
    seedRandom(s);
    const r = runToBreach(n, WOOD, 8000);
    sum += r.tick > 0 ? r.tick : 8000; // count a miss as the cap (pessimistic)
  }
  return sum / SEEDS.length;
}
const avg1 = avgTicks(1);
const avg4 = avgTicks(4);
const b2Pass = avg4 < avg1;
console.log(
  'B2 avg ticks-to-breach  n=1:', avg1.toFixed(1),
  ' n=4:', avg4.toFixed(1),
  ' (ratio', (avg1 / avg4).toFixed(2) + 'x faster)',
);
console.log('B2 PASS n=4 breaches in materially fewer ticks than n=1:', b2Pass);

// =====================================================================
// B3 — raw STONE (hasIntegrity=false) is NEVER chipped or destroyed.
// =====================================================================
seedRandom(7);
const { zombies: zs, target: tg } = buildScene(4, STONE);
// No chippable structure ahead: findBlockingStructureCell must return null.
const stoneCell = findBlockingStructureCell(zs[0].body, 1);
const stoneInteg0 = getIntegrity(FENCE_X, FLOOR - 1);
for (let t = 1; t <= 2000; t++) {
  for (const z of zs) updateZombie(z, [tg]);
  resolveBreaching(zs);
}
let stoneIntact = true;
for (let y = FENCE_TOP; y <= FLOOR - 1; y++) {
  if (get(FENCE_X, y) !== STONE || getIntegrity(FENCE_X, y) !== 0) stoneIntact = false;
}
const b3Pass = stoneCell === null && stoneIntact && stoneInteg0 === 0;
console.log(
  'B3 findBlockingStructureCell(stone):', stoneCell,
  'stone integrity start', stoneInteg0,
  'stone column intact after 2000 ticks:', stoneIntact,
);
console.log('B3 PASS raw stone never breached (no integrity):', b3Pass);

console.log('\nSUMMARY', 'B1', b1Pass, 'B2', b2Pass, 'B3', b3Pass,
  '| ALL', b1Pass && b2Pass && b3Pass);
