declare const process: any;
/**
 * s-soak.test.ts — playtest v0.11 round 10 item S: rain floods should SOAK
 * INTO the ground over time (simulation.applySoak, GDD §10). Real modules,
 * chunking OFF for the behavioural scenes (byte-equivalence with chunking ON
 * is pinned separately by the p11-chunk-equiv battery, scenario g).
 *
 * Done-when:
 *   1. A shallow standing sheet on DIRT drains to ZERO with soak as the ONLY
 *      valve (weather pinned to snow: evaporation is clear-only, ambient melt
 *      is off at TEMP_SNOW) — bottom-up ground absorption works.
 *   2. The SAME sheet in a STONE-bottomed basin loses NOTHING over the same
 *      window (stone is waterproof) — this is exactly why the worldgen
 *      drinking pond and the aquifers (all carved into stone) never drain.
 *   3. During RAIN the pass is off: no sheet-bottom cell on dirt is ever
 *      absorbed while the storm runs (storms flood; drainage runs after).
 *   4. A water body deeper than SOAK_MAX_DEPTH never soaks (open lakes and
 *      deep pit ponds persist).
 *   5. Feature-level: in CLEAR weather (soak + R8 evaporation together) a
 *      post-storm flood sheet is fully gone within a few thousand ticks.
 */

import { WORLD_W, WORLD_H, SOAK_MAX_DEPTH } from '../src/config';
import { WATER, DIRT, STONE, AIR, SNOW } from '../src/engine/materials';
import { material, integrity, idx, get, set } from '../src/engine/grid';
import { step } from '../src/engine/simulation';
import { setChunkingEnabled } from '../src/engine/chunks';
import { __setWeatherForTest } from '../src/engine/weather';

let failures = 0;
function check(cond: boolean, msg: string): void {
  console.log((cond ? 'PASS: ' : 'FAIL: ') + msg);
  if (!cond) failures++;
}
function countMat(m: number): number {
  let n = 0;
  for (let i = 0; i < material.length; i++) if (material[i] === m) n++;
  return n;
}
function clear(): void {
  material.fill(AIR);
  integrity.fill(0);
}
const FLOOR = 150;
/**
 * A walled basin holding a standing sheet: STONE side walls, `bed` material
 * floor (2 deep on a stone shelf), `depth` rows of WATER inside. Walls rise
 * above the water line so the sheet cannot spill out.
 */
function basin(x0: number, x1: number, bed: number, depth: number): void {
  for (let x = x0 - 1; x <= x1 + 1; x++)
    for (let y = FLOOR; y < FLOOR + 4; y++) set(x, y, STONE); // shelf
  for (let y = FLOOR - depth - 4; y < FLOOR; y++) {
    set(x0 - 1, y, STONE); // walls
    set(x1 + 1, y, STONE);
  }
  for (let x = x0; x <= x1; x++)
    for (let y = FLOOR - 2; y < FLOOR; y++) set(x, y, bed); // bed (2 rows)
  for (let x = x0; x <= x1; x++)
    for (let y = FLOOR - 2 - depth; y < FLOOR - 2; y++) set(x, y, WATER);
}

setChunkingEnabled(false);

// ── 1. Snow-pinned (soak is the only valve): dirt-bottomed sheet drains to 0 ──
console.log('--- 1: sheet on DIRT drains (soak only) ---');
clear();
basin(120, 180, DIRT, 2);
__setWeatherForTest('snow');
const startWater = countMat(WATER);
check(startWater === 61 * 2, `1: scene starts with ${61 * 2} water cells (${startWater})`);
for (let t = 0; t < 8000 && countMat(WATER) > 0; t++) step();
console.log(`   water ${startWater} -> ${countMat(WATER)}`);
check(countMat(WATER) === 0, '1: sheet fully absorbed into the dirt (no evap, no melt)');

// ── 2. Same sheet, STONE bed: waterproof — EXACT count over the window ───────
console.log('--- 2: stone basin is waterproof ---');
clear();
basin(120, 180, STONE, 2);
__setWeatherForTest('snow');
const pondStart = countMat(WATER);
for (let t = 0; t < 2500; t++) step();
console.log(`   water ${pondStart} -> ${countMat(WATER)} (snow cells now: ${countMat(SNOW)})`);
check(
  countMat(WATER) === pondStart,
  '2: NOT ONE water cell lost from the stone basin (drinking pond / aquifer contract)',
);

// ── 3. Rain exemption: the sheet bottom on dirt survives the whole storm ─────
console.log('--- 3: no soak during rain ---');
clear();
basin(120, 180, DIRT, 2);
__setWeatherForTest('rain');
for (let t = 0; t < 1200; t++) step();
let bottomIntact = true;
for (let x = 120; x <= 180; x++) {
  if (get(x, FLOOR - 3) !== WATER) bottomIntact = false; // row resting on the bed
}
check(bottomIntact, '3: every sheet-bottom cell on dirt still WATER after 1200 rain ticks');

// ── 4. Deep-body cap: a pit pond deeper than SOAK_MAX_DEPTH never soaks ──────
console.log('--- 4: deep water never soaks ---');
clear();
basin(130, 170, DIRT, SOAK_MAX_DEPTH + 2); // surface->floor exceeds the cap
__setWeatherForTest('snow');
const deepStart = countMat(WATER);
for (let t = 0; t < 2500; t++) step();
console.log(`   water ${deepStart} -> ${countMat(WATER)}`);
check(
  countMat(WATER) === deepStart,
  `4: pond deeper than SOAK_MAX_DEPTH(${SOAK_MAX_DEPTH}) unchanged (lakes persist)`,
);

// ── 5. Feature-level: clear weather drains a flood via soak + evaporation ────
console.log('--- 5: post-storm flood gone in clear weather ---');
clear();
basin(120, 180, DIRT, 2);
__setWeatherForTest('clear');
let goneAt = -1;
for (let t = 0; t < 8000; t++) {
  step();
  if (countMat(WATER) === 0) {
    goneAt = t;
    break;
  }
}
console.log(`   flood gone at tick ${goneAt}`);
check(goneAt >= 0, '5: flood sheet fully dissipates in clear weather');

if (failures > 0) {
  console.error(`\nFAILED: ${failures} check(s)`);
  process.exit(1);
}
console.log(
  '\nSUMMARY: standing water soaks into soil bottom-up (snow-pinned drain to 0), stone basins are waterproof to the cell (pond/aquifer contract), rain suspends drainage, deeper-than-cap bodies persist, and a clear spell clears a flood. ALL PASS',
);
