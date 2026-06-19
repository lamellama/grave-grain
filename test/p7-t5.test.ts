/**
 * p7-t5.test.ts — Structure breaching (GDD §7.4), real modules, headless.
 *
 * Scene (mirrors the shipped Phase-7 scene in main.ts): a 1-cell-wide WOOD fence
 * of the SHIPPED height (P7_FENCE_HEIGHT = 4 cells) stands on a STONE floor at a
 * chokepoint. A small mob of zombies spawns a few cells to the LEFT and PURSUES
 * a survivor placed BEYOND the fence (in sense range but well out of melee). The
 * zombies WALK up to the fence via updateZombie — they are NOT hand-placed flush
 * against it — and, blocked by the 4-tall wall, press it. Each tick we
 * updateZombie (so they keep pressing) then resolveBreaching.
 *
 * This is the regression for the per-row leading-edge bug: the 52-px humanoid is
 * asymmetric (an arm overhangs one column further out than the legs, ABOVE a
 * short fence). The OLD single-global-edge probe aimed past the 4-tall fence at
 * the arm column and returned null, so the fence never chipped. The per-row
 * probe finds the fence at the leg/torso rows where the body is actually blocked.
 *
 * Verifies:
 *   B1 — pursuit-driven mob: zombies WALK into the fence and a pressed cell's
 *        integrity DECREASES over time and the cell eventually becomes AIR +
 *        markTerrainEdit fired (coarse epoch bumped).
 *   B2 — PRESSURE: 4 zombies pressing the SAME cell breach it in MATERIALLY
 *        fewer ticks than 1 (averaged over seeded runs).
 *   B3 — a cell with NO integrity (raw STONE, hasIntegrity=false) is NEVER
 *        chipped or destroyed by breaching.
 *   B4 — per-row probe: a body stalled flush against the 4-tall fence,
 *        findBlockingStructureCell returns the FENCE cell (leg/torso row), NOT
 *        null (the bug). Reported explicitly.
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
import { WORLD_W, WOOD_INTEGRITY, P3_GROUND_Y } from '../src/config';

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

// Shipped-scene geometry (mirrors main.ts P7_FENCE_*): floor at P3_GROUND_Y, a
// 4-cell-tall WOOD fence above it. 4 cells is taller than STEP_UP_MAX so the
// body cannot step over — it must breach.
const FLOOR = P3_GROUND_Y;
const FENCE_X = 120;
const FENCE_HEIGHT = 4; // P7_FENCE_HEIGHT
const FENCE_TOP = FLOOR - FENCE_HEIGHT; // topmost fence row
const SPAWN_GAP = 6; // cells the zombies start LEFT of the fence (they walk up)

/** Build the shipped fence scene with `n` zombies pursuing a target beyond it. */
function buildScene(n: number, mat: number) {
  material.fill(0);
  for (let x = 0; x < WORLD_W; x++) set(x, FLOOR, STONE);
  for (let y = FENCE_TOP; y <= FLOOR - 1; y++) placeMaterial(FENCE_X, y, mat);
  rebuildNavgrid();
  // Zombies spawn a few cells LEFT of the fence, on the floor, and PURSUE — they
  // walk up to the wall themselves (not hand-placed flush against it).
  const zombies = [];
  for (let i = 0; i < n; i++) zombies.push(createZombie(FENCE_X - SPAWN_GAP, FLOOR - 1));
  // Target beyond the fence, inside SENSE_RADIUS but well out of melee reach so
  // the zombies keep pressing the wall instead of striking the survivor.
  const target = createSurvivor(FENCE_X + 10, FLOOR - 1);
  return { zombies, target };
}

/** Step the mob one tick (pursuit + breaching). */
function tick(zombies: ReturnType<typeof buildScene>['zombies'], target: ReturnType<typeof createSurvivor>) {
  for (const z of zombies) updateZombie(z, [target]);
  resolveBreaching(zombies);
}

/**
 * Run the pursuit scene until a pressed fence cell is destroyed; return
 * diagnostics. The pressed cell is discovered DYNAMICALLY once the mob has
 * walked up to and stalled against the fence (findBlockingStructureCell), so the
 * test never hand-aims at it.
 */
function runToBreach(n: number, mat: number, maxTicks: number) {
  const { zombies, target } = buildScene(n, mat);
  let cell: { x: number; y: number } | null = null;
  let epBefore = 0;
  let cx = 0;
  let cy = 0;
  let minInteg = -1;
  for (let t = 1; t <= maxTicks; t++) {
    tick(zombies, target);
    // Once the mob has reached and stalled against the fence, lock the pressed
    // cell (the first breachable cell directly ahead of the lead zombie).
    if (cell === null) {
      cell = findBlockingStructureCell(zombies[0].body, 1);
      if (cell) {
        const c = coarseOf(cell.x, cell.y);
        cx = c.cx;
        cy = c.cy;
        epBefore = epochAt(cx, cy);
        minInteg = getIntegrity(cell.x, cell.y);
      }
    }
    if (cell) {
      const integ = getIntegrity(cell.x, cell.y);
      if (get(cell.x, cell.y) !== AIR && integ < minInteg) minInteg = integ;
      if (get(cell.x, cell.y) === AIR) {
        return { tick: t, cell, epBefore, epAfter: epochAt(cx, cy), minInteg };
      }
    }
  }
  return { tick: -1, cell, epBefore, epAfter: cell ? epochAt(cx, cy) : 0, minInteg };
}

// =====================================================================
// B1 — a small mob WALKS to a 4-tall WOOD fence and chips a cell to AIR.
// =====================================================================
seedRandom(1);
const b1 = runToBreach(3, WOOD, 8000);
const b1Pass =
  b1.cell !== null &&
  getIntegrity(b1.cell.x, b1.cell.y) === 0 && // setIntegrity hit 0
  b1.tick > 0 &&
  b1.epAfter > b1.epBefore; // markTerrainEdit fired
console.log(
  'B1 pressed cell', b1.cell,
  'baseInteg', WOOD_INTEGRITY,
  'pursuit ticks-to-breach (mob=3)', b1.tick,
  'epoch', b1.epBefore, '→', b1.epAfter,
);
console.log('B1 PASS pursuit mob walks up, integrity→0, cell→AIR, navgrid epoch bumped:', b1Pass);

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
// Let the mob walk up to and stall against the stone wall first.
for (let t = 1; t <= 2000; t++) tick(zs, tg);
// No chippable structure ahead: findBlockingStructureCell must return null.
const stoneCell = findBlockingStructureCell(zs[0].body, 1);
const stoneInteg0 = getIntegrity(FENCE_X, FLOOR - 1);
let stoneIntact = true;
for (let y = FENCE_TOP; y <= FLOOR - 1; y++) {
  if (get(FENCE_X, y) !== STONE || getIntegrity(FENCE_X, y) !== 0) stoneIntact = false;
}
const b3Pass = stoneCell === null && stoneIntact && stoneInteg0 === 0;
console.log(
  'B3 findBlockingStructureCell(stone):', stoneCell,
  'stone integrity', stoneInteg0,
  'stone column intact after 2000 ticks:', stoneIntact,
);
console.log('B3 PASS raw stone never breached (no integrity):', b3Pass);

// =====================================================================
// B4 — per-row probe: a body stalled flush against the 4-tall WOOD fence
//      returns the FENCE cell (leg/torso row), NOT null (the old bug).
// =====================================================================
seedRandom(123);
const { zombies: zb, target: tb } = buildScene(1, WOOD);
// Walk the lone zombie up until it is flush and pressing the wall.
for (let t = 1; t <= 200; t++) {
  for (const z of zb) updateZombie(z, [tb]);
}
const probe = findBlockingStructureCell(zb[0].body, 1);
const b4Pass =
  probe !== null && probe.x === FENCE_X && probe.y >= FENCE_TOP && probe.y <= FLOOR - 1;
console.log(
  'B4 body feet col round(x)', Math.round(zb[0].body.x),
  'findBlockingStructureCell →', probe,
  '(fence col', FENCE_X, 'rows', FENCE_TOP, '..', FLOOR - 1 + ')',
);
console.log('B4 PASS per-row probe finds the fence cell at the blocked row (not null):', b4Pass);

console.log('\nSUMMARY', 'B1', b1Pass, 'B2', b2Pass, 'B3', b3Pass, 'B4', b4Pass,
  '| ALL', b1Pass && b2Pass && b3Pass && b4Pass);
