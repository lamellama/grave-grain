declare const process: any;
/**
 * n-stonegravity.test.ts - playtest v0.9 N: "stone should obey gravity".
 * STONE (id 2) now has a sim rule: a LONE stone - no orthogonal STONE or WALL
 * neighbour ("mortar") - falls STRAIGHT down through air/fluids and rests on
 * whatever it lands on; any mortar contact makes it static exactly as before,
 * so worldgen strata, mined galleries, walls and stone piles never collapse.
 * Headless Node test over REAL engine modules.
 *
 * Done-when:
 *   1. LONE STONE FALLS - a single suspended stone drops straight down, lands
 *      on the floor, re-mortars to it and rests (mass conserved, no tunnel,
 *      no sideways drift - it is a rock, not a powder).
 *   2. MORTARED HOLDS - a suspended PAIR (and a column) never moves: touching
 *      stone is "mortared" per the playtest rule.
 *   3. WALL IS MORTAR - a lone stone flush against a built WALL holds with air
 *      below it (walls are mortared stone).
 *   4. SUPPORTED RESTS - a lone stone sitting on DIRT (and on SAND) stays put:
 *      gravity only matters over air/fluid, and stone never displaces powders.
 *   5. SINKS THROUGH WATER - a lone stone dropped into a pool falls to the
 *      pool floor (density 255 vs fluid 1) and mortars to it.
 *   6. EDIT WAKES + DROPS (chunked) - with chunking ON and the world settled,
 *      deleting the support under a lone stone wakes the chunk and the stone
 *      falls on the following passes (the dirty-rect reactivation contract).
 *   7. SETTLED STAYS SETTLED - a resting mortared world processes ~0 chunks
 *      (the new rule adds no perpetual chunk churn).
 */

import { WORLD_W } from '../src/config';
import { STONE, WALL, DIRT, SAND, WATER, AIR } from '../src/engine/materials';
import { material, integrity, set, get } from '../src/engine/grid';
import * as sim from '../src/engine/simulation';
import { __setWeatherForTest } from '../src/engine/weather';

// Pin CLEAR weather for the whole file: a mid-test transition to rain/snow
// would sky-spawn cells into the scenes and break the settle/no-drift checks.
__setWeatherForTest('clear');

let failures = 0;
function check(cond: boolean, msg: string): void {
  console.log((cond ? 'PASS: ' : 'FAIL: ') + msg);
  if (!cond) failures++;
}

const FLOOR = 150;

/** Wipe the world and lay a full-width STONE floor (mutually mortared). */
function flatWorld(): void {
  material.fill(AIR);
  integrity.fill(0);
  for (let x = 0; x < WORLD_W; x++) set(x, FLOOR, STONE);
}

function count(mat: number): number {
  let n = 0;
  for (let i = 0; i < material.length; i++) if (material[i] === mat) n++;
  return n;
}

// ===========================================================================
// 1. LONE STONE FALLS straight down, lands, rests.
// ===========================================================================
console.log('\n=== 1 lone stone falls straight down ===');
{
  flatWorld();
  sim.setChunkingEnabled(false);
  set(130, 100, STONE);
  const before = count(STONE);
  for (let t = 0; t < 80; t++) sim.step();
  check(count(STONE) === before, 'mass conserved (no stone created/destroyed)');
  check(get(130, 100) === AIR, 'left its suspension point');
  check(get(130, FLOOR - 1) === STONE, 'landed directly on the floor (straight-down, no drift)');
  // Rests: no further movement once mortared to the floor below.
  for (let t = 0; t < 40; t++) sim.step();
  check(get(130, FLOOR - 1) === STONE, 'rests there (re-mortared to the floor)');
  // No tunnel: nothing below the floor row.
  let below = 0;
  for (let y = FLOOR + 1; y < 200; y++) if (get(130, y) === STONE && y !== FLOOR) below++;
  check(below === 0, 'no-tunnel: never fell through the floor');
}

// ===========================================================================
// 2. MORTARED HOLDS - pair and column stay suspended forever.
// ===========================================================================
console.log('\n=== 2 mortared stone holds ===');
{
  flatWorld();
  sim.setChunkingEnabled(false);
  set(110, 100, STONE); // horizontal pair
  set(111, 100, STONE);
  for (let y = 95; y < 101; y++) set(160, y, STONE); // vertical column
  for (let t = 0; t < 120; t++) sim.step();
  check(get(110, 100) === STONE && get(111, 100) === STONE, 'suspended PAIR held (mutual mortar)');
  let columnIntact = true;
  for (let y = 95; y < 101; y++) if (get(160, y) !== STONE) columnIntact = false;
  check(columnIntact, 'suspended COLUMN held (chain mortar)');
}

// ===========================================================================
// 3. WALL IS MORTAR - lone stone flush against a WALL holds over air.
// ===========================================================================
console.log('\n=== 3 wall counts as mortar ===');
{
  flatWorld();
  sim.setChunkingEnabled(false);
  for (let y = 96; y <= 104; y++) set(120, y, WALL); // a built wall segment
  set(121, 100, STONE); // lone stone stuck to its side, AIR below
  for (let t = 0; t < 100; t++) sim.step();
  check(get(121, 100) === STONE, 'stone mortared to a WALL holds with air below');
}

// ===========================================================================
// 4. SUPPORTED RESTS - on dirt and on sand (never displaces a powder).
// ===========================================================================
console.log('\n=== 4 supported lone stone rests (dirt/sand) ===');
{
  flatWorld();
  sim.setChunkingEnabled(false);
  // A dirt block on the floor with one stone on top (no stone contact).
  for (let y = FLOOR - 3; y < FLOOR; y++)
    for (let x = 138; x <= 142; x++) set(x, y, DIRT);
  set(140, FLOOR - 4, STONE);
  // A sand heap with one stone on top.
  for (let y = FLOOR - 2; y < FLOOR; y++)
    for (let x = 170; x <= 174; x++) set(x, y, SAND);
  set(172, FLOOR - 3, STONE);
  for (let t = 0; t < 100; t++) sim.step();
  check(get(140, FLOOR - 4) === STONE, 'stone on DIRT stays put (supported, not displacing)');
  check(get(172, FLOOR - 3) === STONE, 'stone on SAND rests on the powder (never sinks into it)');
}

// ===========================================================================
// 5. SINKS THROUGH WATER to the pool floor.
// ===========================================================================
console.log('\n=== 5 lone stone sinks through water ===');
{
  flatWorld();
  sim.setChunkingEnabled(false);
  for (let y = 96; y <= 104; y++) {
    set(199, y, STONE); // pool walls (mortared columns)
    set(221, y, STONE);
  }
  // Rebuild a local floor higher up so the pool is shallow and contained.
  for (let x = 199; x <= 221; x++) set(x, 105, STONE);
  for (let y = 98; y < 105; y++)
    for (let x = 200; x <= 220; x++) set(x, y, WATER);
  set(210, 90, STONE); // dropped above the pool
  for (let t = 0; t < 60; t++) sim.step();
  check(get(210, 104) === STONE, 'stone sank through the water to the pool floor');
  check(get(210, 90) === AIR, 'and is gone from the drop point');
}

// ===========================================================================
// 6. EDIT WAKES + DROPS under chunking (dirty-rect reactivation contract).
// ===========================================================================
console.log('\n=== 6 chunked: removing the support drops the stone ===');
{
  flatWorld();
  sim.setChunkingEnabled(true);
  // A lone stone resting on a small DIRT platform on the floor: no stone/wall
  // contact (unmortared - a WALL support would itself be mortar) but SUPPORTED
  // by the dirt, so the world can fully settle with it in place.
  for (let x = 599; x <= 601; x++) set(x, FLOOR - 1, DIRT); // platform on the floor
  set(600, FLOOR - 2, STONE); // lone stone on dirt: unmortared, supported
  for (let t = 0; t < 8; t++) sim.step(); // let the world settle
  check(sim.activeThisTickCount() === 0, 'world settled before the edit (0 active chunks)');
  check(get(600, FLOOR - 2) === STONE, 'stone resting on the dirt platform pre-edit');

  set(600, FLOOR - 1, AIR); // mine out the support (grid edit wakes the chunk)
  for (let t = 0; t < 6; t++) sim.step();
  check(get(600, FLOOR - 2) === AIR, 'stone left its perch after the edit (chunk woke)');
  check(get(600, FLOOR - 1) === STONE, 'and fell into the mined-out gap onto the floor');
}

// ===========================================================================
// 7. SETTLED STAYS SETTLED - the new rule adds no perpetual churn.
// ===========================================================================
console.log('\n=== 7 settled mortared world processes ~0 chunks ===');
{
  flatWorld();
  sim.setChunkingEnabled(true);
  for (let y = 96; y < 101; y++) set(300, y, STONE); // a held column too
  for (let t = 0; t < 8; t++) sim.step();
  check(
    sim.activeThisTickCount() === 0,
    `fully mortared world settles to 0 active chunks (got ${sim.activeThisTickCount()})`,
  );
}

console.log('\n' + (failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'));
process.exit(failures === 0 ? 0 : 1);
