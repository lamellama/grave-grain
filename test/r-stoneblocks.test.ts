declare const process: any;
/**
 * r-stoneblocks.test.ts — playtest v0.11 round 10 item R: "stone should work
 * like stone blocks — fall under gravity but stack together to create walls"
 * (simulation.updateStone, GDD §5.2). Real modules, chunking OFF here
 * (chunked-vs-full byte-equivalence incl. the travelling marker is pinned by
 * the extended p11-chunk-equiv scenario f).
 *
 * The rule: PLACED stone (player paint via placeMaterial) and FALLEN stone
 * (rubble) carry the STONE_LOOSE integrity marker — a loose block rests ONLY
 * on support from BELOW, so blocks fall and STACK into columns/walls, and
 * lateral contact never defies gravity. UNMARKED stone is NATIVE rock and
 * keeps the v0.9 N mortar rule (strata, galleries, overhangs stay standing).
 *
 * Done-when:
 *   1. A painted mid-air block falls straight down and lands on the floor.
 *   2. Painted blocks STACK: a suspended 3-stack lands as a 3-high column;
 *      two adjacent stacks stand as a 2-wide wall; all stable thereafter.
 *   3. THE ASK: a block painted in mid-air touching only the SIDE of a
 *      standing column FALLS to the ground beside it (the old rule hung it).
 *   4. Native rock unchanged: a suspended native pair holds; a mined gallery
 *      keeps its roof (lateral mortar) — mining/digging stays viable.
 *   5. Fallen native rubble never re-hangs: a lone native stone falling past
 *      a tall column's face drops all the way to the floor (old rule: it
 *      re-mortared to the side mid-air) and lands marked LOOSE.
 *   6. Marker hygiene: vacated cells are cleared; every landed block carries
 *      STONE_LOOSE (it travelled with the fall).
 */

import { WORLD_W, STONE_LOOSE } from '../src/config';
import { STONE, DIRT, AIR } from '../src/engine/materials';
import {
  material,
  integrity,
  get,
  set,
  placeMaterial,
  getIntegrity,
} from '../src/engine/grid';
import { step } from '../src/engine/simulation';
import { setChunkingEnabled } from '../src/engine/chunks';
import { __setWeatherForTest } from '../src/engine/weather';
import { placeStructure } from '../src/game/building';
import { addResource, getStockpile, resetStockpile } from '../src/game/resources';

let failures = 0;
function check(cond: boolean, msg: string): void {
  console.log((cond ? 'PASS: ' : 'FAIL: ') + msg);
  if (!cond) failures++;
}
const FLOOR = 150;
function clear(): void {
  material.fill(AIR);
  integrity.fill(0);
  for (let x = 50; x <= 400; x++) set(x, FLOOR, STONE); // native floor slab
  for (let x = 50; x <= 400; x++) set(x, FLOOR + 1, STONE);
}
function run(n: number): void {
  for (let t = 0; t < n; t++) step();
}

setChunkingEnabled(false);
__setWeatherForTest('clear'); // no precipitation in the scenes

// ── 1. A painted mid-air block falls and lands ───────────────────────────────
console.log('--- 1: painted block falls ---');
clear();
placeMaterial(100, 120, STONE);
run(60);
check(get(100, 120) === AIR, '1: launch cell vacated');
check(get(100, FLOOR - 1) === STONE, '1: block landed on the floor');
check(getIntegrity(100, FLOOR - 1) === STONE_LOOSE, '6: marker travelled with the fall');
check(getIntegrity(100, 120) === 0, '6: vacated cell marker cleared');

// ── 2. Blocks stack into columns and walls ───────────────────────────────────
console.log('--- 2: blocks stack ---');
clear();
for (let y = 110; y < 113; y++) placeMaterial(140, y, STONE); // 3-stack, mid-air
for (let y = 115; y < 117; y++) placeMaterial(141, y, STONE); // neighbour 2-stack
run(80);
let columnOk = true;
for (let y = FLOOR - 3; y < FLOOR; y++) if (get(140, y) !== STONE) columnOk = false;
check(columnOk, '2: 3-high column re-stacked on the floor');
let wallOk = true;
for (let y = FLOOR - 2; y < FLOOR; y++) if (get(141, y) !== STONE) wallOk = false;
check(wallOk, '2: adjacent 2-stack stands beside it (a wall)');
const snapshotBefore = material.slice();
run(120);
let stable = true;
for (let i = 0; i < material.length; i++)
  if (material[i] !== snapshotBefore[i]) stable = false;
check(stable, '2: the built wall is STABLE (no further movement in 120 ticks)');

// ── 3. THE ASK: side-glued block falls instead of floating ──────────────────
console.log('--- 3: lateral contact never defies gravity ---');
clear();
for (let y = FLOOR - 6; y < FLOOR; y++) set(200, y, STONE); // native column
placeMaterial(201, FLOOR - 5, STONE); // painted block glued to its SIDE, air below
run(60);
check(get(201, FLOOR - 5) === AIR, '3: side-glued block did NOT hang mid-air');
check(get(201, FLOOR - 1) === STONE, '3: it fell and landed at the column foot');
let columnIntact = true;
for (let y = FLOOR - 6; y < FLOOR; y++) if (get(200, y) !== STONE) columnIntact = false;
check(columnIntact, '3: the native column itself still stands');

// ── 4. Native rock semantics unchanged (galleries survive mining) ────────────
console.log('--- 4: native mortar preserved ---');
clear();
set(250, 100, STONE); // suspended native pair (mutual mortar) -> holds
set(251, 100, STONE);
// A native slab with a mined-out gallery below its roof:
for (let x = 280; x <= 300; x++)
  for (let y = 130; y <= 140; y++) set(x, y, STONE);
for (let x = 283; x <= 297; x++)
  for (let y = 134; y <= 139; y++) set(x, y, AIR); // mine the gallery
run(120);
check(
  get(250, 100) === STONE && get(251, 100) === STONE,
  '4: suspended native pair still holds (v0.9 N contract)',
);
let roofOk = true;
for (let x = 283; x <= 297; x++)
  for (let y = 130; y <= 133; y++) if (get(x, y) !== STONE) roofOk = false;
check(roofOk, '4: mined gallery keeps its roof (mining/digging stays viable)');

// ── 5. Fallen rubble never re-hangs on a passing wall face ───────────────────
console.log('--- 5: falling rubble passes a column face ---');
clear();
for (let y = FLOOR - 20; y < FLOOR; y++) set(320, y, STONE); // tall native column
set(321, FLOOR - 25, STONE); // lone native stone above the column's FACE side
run(80);
check(get(321, FLOOR - 25) === AIR, '5: lone stone fell (no mortar at launch)');
let hungMidair = false;
for (let y = FLOOR - 24; y < FLOOR - 1; y++) if (get(321, y) === STONE) hungMidair = true;
check(!hungMidair, '5: it never re-hung off the column face on the way down');
check(get(321, FLOOR - 1) === STONE, '5: it landed at the column foot');
check(getIntegrity(321, FLOOR - 1) === STONE_LOOSE, '5: fallen native rock is LOOSE rubble now');

// ── 7. The toolbar verb: placeStructure('stone') = costed falling block ─────
console.log('--- 7: costed stone-block placement (the toolbar Stone verb) ---');
clear();
resetStockpile();
check(!placeStructure(380, 120, 'stone'), '7: refused with an empty stockpile');
addResource('stone', 2);
check(placeStructure(380, 120, 'stone'), '7: placed once affordable');
check(getStockpile().stone === 1, '7: exactly one stone spent');
check(getIntegrity(380, 120) === STONE_LOOSE, '7: placed cell is a LOOSE block');
run(60);
check(
  get(380, 120) === AIR && get(380, FLOOR - 1) === STONE,
  '7: the placed block FELL and landed (the playtest ask, end to end)',
);

// ── 6b. Loose block rests on soil too (not just stone) ───────────────────────
console.log('--- 6: rests on any solid ---');
clear();
for (let x = 360, y = FLOOR - 1; x <= 370; x++) set(x, y, DIRT); // dirt shelf on the slab
placeMaterial(365, 130, STONE);
run(60);
check(get(365, FLOOR - 2) === STONE, '6: block rests ON dirt (below-support is any solid)');

if (failures > 0) {
  console.error(`\nFAILED: ${failures} check(s)`);
  process.exit(1);
}
console.log(
  '\nSUMMARY: placed stone falls as blocks and stacks into stable columns/walls; lateral contact never defies gravity (side-glued and falling stones drop to the floor, fallen rock stays loose); native strata/galleries keep the mortar rule so mining is unharmed. ALL PASS',
);
