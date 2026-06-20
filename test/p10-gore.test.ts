/**
 * Headless verification for task 10-8 (Mobile gore budget — cap + fade).
 * Imports the REAL modules (no mocks). Run via tsc (commonjs) -> node.
 *
 * Covers GDD §13 (cap gore debris; fade so it doesn't accumulate forever):
 *   1. Gore stabilises: a huge block of loose FLESH/BONE/BLOOD, well over
 *      MAX_GORE_CELLS, fades down to <= MAX_GORE_CELLS within ~2000 ticks and
 *      then holds (does not stay huge, does not grow).
 *   2. Terrain safe: STONE/DIRT/WOOD/WALL among the gore are NEVER removed.
 *   3. Below-cap unaffected: a small FLESH/BONE pile falls/settles normally,
 *      mass conserved, no premature fading.
 */
import {
  WORLD_W,
  WORLD_H,
  MAX_GORE_CELLS,
  GORE_FADE_PER_TICK,
} from '../src/config';
import {
  FLESH,
  BONE,
  BLOOD,
  STONE,
  DIRT,
  WOOD,
  WALL,
  AIR,
} from '../src/engine/materials';
import { material, idx, set } from '../src/engine/grid';
import { step } from '../src/engine/simulation';

function fail(msg: string): never {
  console.log('FAIL:', msg);
  throw new Error(msg);
}
function ok(msg: string): void {
  console.log('PASS:', msg);
}

function isLooseDebris(m: number): boolean {
  return m === FLESH || m === BONE || m === BLOOD;
}
function countDebris(): number {
  let n = 0;
  for (let i = 0; i < material.length; i++) if (isLooseDebris(material[i])) n++;
  return n;
}
function countMat(target: number): number {
  let n = 0;
  for (let i = 0; i < material.length; i++) if (material[i] === target) n++;
  return n;
}

// ===========================================================================
// 1. + 2.  Gore stabilises at the cap; terrain among it is never removed.
// ===========================================================================
material.fill(AIR);

const FLOOR_Y = WORLD_H - 4;
// Solid STONE floor row (must survive untouched).
for (let x = 0; x < WORLD_W; x++) set(x, FLOOR_Y, STONE);

// Scatter a handful of terrain/structure cells AMONG where the gore will land,
// resting on the floor, to prove the fade never AIR-ifies terrain.
const terrainCells: Array<{ x: number; y: number; mat: number }> = [];
const terrainMats = [STONE, DIRT, WOOD, WALL];
for (let k = 0; k < 40; k++) {
  const x = 20 + k * 7;
  const y = FLOOR_Y - 1; // sitting on the floor
  const mat = terrainMats[k % terrainMats.length];
  set(x, y, mat);
  terrainCells.push({ x, y, mat });
}
const terrainBefore = {
  stone: countMat(STONE),
  dirt: countMat(DIRT),
  wood: countMat(WOOD),
  wall: countMat(WALL),
};

// Seed a LARGE block of loose body-debris well over MAX_GORE_CELLS, but small
// enough that GORE_FADE_PER_TICK can drain it under the cap inside ~2000 ticks
// and then visibly HOLD at the cap (sized to reach the cap around t~1000).
// Rows above the floor, skipping any cell already holding terrain.
let seeded = 0;
const blockTop = FLOOR_Y - 35;
for (let y = blockTop; y < FLOOR_Y; y++) {
  for (let x = 10; x < 310; x++) {
    if (material[idx(x, y)] !== AIR) continue;
    // Mix the three debris materials so we exercise all of them.
    const r = (x + y) % 5;
    const m = r === 0 ? BLOOD : r === 1 ? BONE : FLESH;
    set(x, y, m);
    seeded++;
  }
}
console.log(`seeded loose-debris cells = ${seeded} (cap = ${MAX_GORE_CELLS})`);
if (seeded <= MAX_GORE_CELLS) {
  fail(`seed ${seeded} not over the cap ${MAX_GORE_CELLS} — test invalid`);
}

const curve: Record<string, number> = {};
curve['0'] = countDebris();
for (let t = 1; t <= 2000; t++) {
  step();
  if (t === 500 || t === 1000 || t === 2000) curve[String(t)] = countDebris();
}
console.log(
  `gore curve: t0=${curve['0']} t500=${curve['500']} ` +
    `t1000=${curve['1000']} t2000=${curve['2000']}`,
);

// Stabilises at <= cap (allow a small margin from the recount cadence).
const MARGIN = 50;
const finalCount = curve['2000'];
if (finalCount > MAX_GORE_CELLS + MARGIN) {
  fail(
    `gore did not stabilise: ${finalCount} still > cap ${MAX_GORE_CELLS} (+${MARGIN})`,
  );
}
ok(`gore stabilised at ${finalCount} <= ${MAX_GORE_CELLS} (+${MARGIN})`);

// Trended DOWN, not up (debris fell from well-over-cap toward the cap).
if (!(curve['2000'] < curve['0'])) {
  fail(`gore did not trend down: t0=${curve['0']} -> t2000=${curve['2000']}`);
}
ok(`gore trended down ${curve['0']} -> ${finalCount}`);

// Held steady once near the cap (1000 vs 2000 shouldn't diverge much).
if (Math.abs(curve['2000'] - curve['1000']) > MAX_GORE_CELLS) {
  fail('gore count unstable between t1000 and t2000');
}
ok(`gore held steady t1000=${curve['1000']} ~ t2000=${curve['2000']}`);

// Terrain safe: NO terrain/structure cell removed by the fade.
const terrainAfter = {
  stone: countMat(STONE),
  dirt: countMat(DIRT),
  wood: countMat(WOOD),
  wall: countMat(WALL),
};
if (
  terrainAfter.stone < terrainBefore.stone ||
  terrainAfter.dirt !== terrainBefore.dirt ||
  terrainAfter.wood !== terrainBefore.wood ||
  terrainAfter.wall !== terrainBefore.wall
) {
  fail(
    `terrain changed: before=${JSON.stringify(terrainBefore)} ` +
      `after=${JSON.stringify(terrainAfter)}`,
  );
}
// Every individually-placed terrain cell still holds its material.
for (const c of terrainCells) {
  if (material[idx(c.x, c.y)] !== c.mat) {
    fail(`terrain cell (${c.x},${c.y}) was changed from ${c.mat}`);
  }
}
ok('terrain safe: STONE/DIRT/WOOD/WALL counts + cells unchanged by the fade');

// Floor row fully intact.
let floorIntact = 0;
for (let x = 0; x < WORLD_W; x++) if (material[idx(x, FLOOR_Y)] === STONE) floorIntact++;
if (floorIntact !== WORLD_W) fail(`floor degraded: ${floorIntact}/${WORLD_W} STONE`);
ok(`floor intact (${floorIntact}/${WORLD_W} STONE)`);

// ===========================================================================
// 3.  Below-cap: a small gore pile falls/settles normally, NO premature fade.
// ===========================================================================
material.fill(AIR);
const F2 = WORLD_H - 4;
for (let x = 0; x < WORLD_W; x++) set(x, F2, STONE);

// A small FLESH/BONE pile (well under the cap) dropped above the floor.
let smallMass = 0;
for (let y = F2 - 20; y < F2 - 8; y++) {
  for (let x = 40; x < 70; x++) {
    const m = (x + y) % 2 === 0 ? FLESH : BONE;
    set(x, y, m);
    smallMass++;
  }
}
if (smallMass >= MAX_GORE_CELLS) fail('small pile not actually under the cap');

function meanY(): number {
  let s = 0;
  let n = 0;
  for (let y = 0; y < WORLD_H; y++) {
    for (let x = 0; x < WORLD_W; x++) {
      const m = material[idx(x, y)];
      if (m === FLESH || m === BONE) {
        s += y;
        n++;
      }
    }
  }
  return n ? s / n : 0;
}
function countFleshBone(): number {
  let n = 0;
  for (let i = 0; i < material.length; i++) {
    if (material[i] === FLESH || material[i] === BONE) n++;
  }
  return n;
}

const massBefore = countFleshBone();
const meanBefore = meanY();
for (let t = 0; t < 60; t++) step();
const massAfter = countFleshBone();
const meanAfter = meanY();

// No premature fade — FLESH/BONE mass conserved (fade never bit under the cap).
if (massAfter !== massBefore) {
  fail(`below-cap mass changed ${massBefore} -> ${massAfter} (premature fade!)`);
}
ok(`below-cap: FLESH/BONE mass conserved (${massAfter}) — no premature fade`);

// It actually fell/settled (meanY increased toward the floor).
if (!(meanAfter > meanBefore)) {
  fail(`below-cap pile did not fall: meanY ${meanBefore.toFixed(2)} -> ${meanAfter.toFixed(2)}`);
}
ok(`below-cap: pile fell/settled (meanY ${meanBefore.toFixed(2)} -> ${meanAfter.toFixed(2)})`);

// No tunnelling below the floor.
let below = 0;
for (let y = F2 + 1; y < WORLD_H; y++) {
  for (let x = 0; x < WORLD_W; x++) {
    if (material[idx(x, y)] === FLESH || material[idx(x, y)] === BONE) below++;
  }
}
if (below > 0) fail(`${below} body cells tunnelled below the floor`);
ok('below-cap: no tunnelling below the floor');

console.log('\nALL PASS');
console.log(
  `SUMMARY: cap=${MAX_GORE_CELLS} fade/tick=${GORE_FADE_PER_TICK} ` +
    `curve(0/500/1000/2000)=${curve['0']}/${curve['500']}/${curve['1000']}/${curve['2000']}`,
);
