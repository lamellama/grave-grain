declare const process: any;
/**
 * r11-dirt.test.ts - playtest round 11: "make the dirt react less like sand;
 * when dug into it shouldn't crumble, unless you try to dig horizontally,
 * then it should collapse" (simulation.updateDirt, GDD 5.2).
 *
 * The rule (the stone loose/native two-population pattern, DIRT_LOOSE):
 *   NATIVE dirt (integrity slot 0 - worldgen/set) is COHESIVE - it falls
 *   straight down when unsupported and NEVER spills sideways.
 *   LOOSE dirt (has fallen once, or painted via placeMaterial) is the old
 *   powder - fall + DIRT_SPILL_CHANCE diagonal spill.
 *
 * Done-when:
 *   1. VERTICAL DIG HOLDS - carving a vertical shaft into a native dirt slab
 *      leaves clean standing walls: no dirt creeps into the shaft, ever.
 *   2. HORIZONTAL DIG COLLAPSES - carving a horizontal tunnel drops its
 *      unsupported ceiling straight down into the cut (mass conserved).
 *   3. PAINTED DIRT STILL PILES - a placeMaterial'd dirt drop spreads into a
 *      mound wider than its source column (the old powder feel is kept for
 *      the paint verb).
 *   4. NATIVE FALL IS STRAIGHT + MARKS LOOSE - a suspended native grain falls
 *      with zero sideways drift and lands carrying DIRT_LOOSE.
 */

import { DIRT_LOOSE } from '../src/config';
import { DIRT, STONE, AIR } from '../src/engine/materials';
import {
  material,
  integrity,
  get,
  set,
  placeMaterial,
  getIntegrity,
  idx,
} from '../src/engine/grid';
import { step } from '../src/engine/simulation';
import { setChunkingEnabled } from '../src/engine/chunks';
import { __setWeatherForTest } from '../src/engine/weather';

let failures = 0;
function check(cond: boolean, msg: string): void {
  console.log((cond ? 'PASS: ' : 'FAIL: ') + msg);
  if (!cond) failures++;
}
const FLOOR = 150; // native stone base under every scene
function clear(): void {
  material.fill(AIR);
  integrity.fill(0);
  for (let x = 20; x <= 460; x++) {
    set(x, FLOOR, STONE);
    set(x, FLOOR + 1, STONE);
  }
}
/** Native dirt slab: columns [x0,x1] filled from `top` down to FLOOR-1. */
function slab(x0: number, x1: number, top: number): void {
  for (let x = x0; x <= x1; x++) {
    for (let y = top; y < FLOOR; y++) set(x, y, DIRT);
  }
}
function countDirt(x0: number, x1: number, y0: number, y1: number): number {
  let n = 0;
  for (let x = x0; x <= x1; x++)
    for (let y = y0; y <= y1; y++) if (get(x, y) === DIRT) n++;
  return n;
}
function run(n: number): void {
  for (let t = 0; t < n; t++) step();
}

setChunkingEnabled(false);
__setWeatherForTest('clear');

// ── 1. Vertical shaft: walls hold, nothing crumbles in ──────────────────────
console.log('--- 1: vertical dig holds ---');
clear();
slab(40, 80, FLOOR - 20);
// Carve a 2-wide vertical shaft down the middle, all the way to the base.
for (let y = FLOOR - 20; y < FLOOR; y++) {
  placeMaterial(60, y, AIR);
  placeMaterial(61, y, AIR);
}
run(300);
let shaftOpen = true;
for (let y = FLOOR - 20; y < FLOOR; y++) {
  if (get(60, y) !== AIR || get(61, y) !== AIR) shaftOpen = false;
}
check(shaftOpen, '1: the shaft stayed fully open (no sideways crumble) after 300 ticks');
let wallsIntact = true;
for (let y = FLOOR - 20; y < FLOOR; y++) {
  if (get(59, y) !== DIRT || get(62, y) !== DIRT) wallsIntact = false;
}
check(wallsIntact, '1: both shaft walls still stand as solid dirt');

// ── 2. Horizontal tunnel: the ceiling collapses into the cut ────────────────
console.log('--- 2: horizontal dig collapses ---');
clear();
slab(120, 170, FLOOR - 20);
// Carve a 3-tall, 16-wide horizontal tunnel with >= 10 rows of dirt above it.
const TUN_TOP = FLOOR - 8;
for (let x = 130, done = 0; done < 16; x++, done++) {
  for (let y = TUN_TOP; y <= TUN_TOP + 2; y++) placeMaterial(x, y, AIR);
}
// Mass baseline AFTER the dig (the shovel removes cells; the collapse must not).
const beforeMass = countDirt(115, 175, FLOOR - 30, FLOOR - 1);
run(400);
// The unsupported ceiling must have dropped: the cut is (at least partly)
// re-filled from above...
const refill = countDirt(130, 145, TUN_TOP, TUN_TOP + 2);
check(refill > 20, `2: tunnel refilled by its collapsing ceiling (${refill}/48 cells dirt)`);
// ...leaving a crater where the ceiling columns used to top out.
const crater = 48 - countDirt(130, 145, FLOOR - 20, FLOOR - 18);
check(crater > 20, `2: the surface above cratered (${crater}/48 former top cells now open)`);
const afterMass = countDirt(115, 175, FLOOR - 30, FLOOR - 1);
check(afterMass === beforeMass, `2: dirt mass conserved through the collapse (${beforeMass} -> ${afterMass})`);

// ── 3. Painted dirt keeps the powder feel ────────────────────────────────────
console.log('--- 3: painted dirt piles ---');
clear();
for (let y = 100; y < 115; y++) placeMaterial(300, y, DIRT); // a poured column
run(400);
check(get(300, 100) === AIR, '3: the poured column dropped');
const footprint =
  countDirt(290, 310, FLOOR - 15, FLOOR - 1) > 0
    ? (() => {
        let minX = 999;
        let maxX = -1;
        for (let x = 290; x <= 310; x++) {
          for (let y = FLOOR - 15; y < FLOOR; y++) {
            if (get(x, y) === DIRT) {
              if (x < minX) minX = x;
              if (x > maxX) maxX = x;
            }
          }
        }
        return maxX - minX + 1;
      })()
    : 0;
check(footprint >= 3, `3: painted dirt spread into a mound (footprint ${footprint} >= 3 columns)`);

// ── 4. Native fall is straight down + marks loose ────────────────────────────
console.log('--- 4: native fall straight + loose marker ---');
clear();
set(400, 100, DIRT); // suspended NATIVE grain (set -> slot 0)
run(120);
check(get(400, 100) === AIR, '4: suspended native grain fell');
check(get(400, FLOOR - 1) === DIRT, '4: it landed in ITS OWN column (zero sideways drift)');
check(getIntegrity(400, FLOOR - 1) === DIRT_LOOSE, '4: the landed grain is marked LOOSE');
check(integrity[idx(400, 100)] === 0, '4: the vacated cell carries no stale marker');

if (failures > 0) {
  console.error(`\nFAILED: ${failures} check(s)`);
  process.exit(1);
}
console.log(
  '\nSUMMARY: native dirt is cohesive - vertical shafts keep clean walls, horizontal tunnels collapse their ceiling straight down (mass conserved), painted dirt still piles as a powder, and any grain that falls becomes loose. ALL PASS',
);
