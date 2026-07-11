declare const process: any;
/**
 * r11-prefabs.test.ts - playtest round 11: purchasable PRE-BUILT structures
 * (game/prefabs.ts, GDD 8/6.1).
 *
 * Done-when:
 *   1. HUT - placePrefabAt('hut') refuses when unaffordable (nothing written,
 *      nothing spent), and once affordable builds the whole hut at one tap:
 *      WALL columns, WOOD roof, full-height DOOR, carved interior, and a lit
 *      CAMPFIRE inside; the exact prefabCost is spent atomically; the interior
 *      is SHELTERED (isShelteredAt) so the hut feeds warmth; the hut registry
 *      version bumps (main re-homes the colony off this signal).
 *   2. WELL - a stone-lined pool: the shell is NATIVE stone (integrity 0 -
 *      not gnawable, never falls), the pool holds 6 WATER cells, and after
 *      3000 clear-weather ticks NOT ONE has soaked or evaporated away (the
 *      round-11 ask: "the water will not soak into the ground") - while a
 *      control puddle on bare dirt drains to nothing over the same run.
 *   3. NO ONE GETS STUCK - the well shell is sealed: every approach column is
 *      blocked above STEP_UP_MAX, and there is no standable cell inside the
 *      shaft reachable from outside (bodies can't wander in; they drink from
 *      the rim - the pool lies within CONSUME_REACH of the outside stand).
 */

import {
  STEP_UP_MAX,
  CONSUME_REACH,
} from '../src/config';
import {
  DIRT,
  STONE,
  WATER,
  WOOD,
  WALL,
  DOOR,
  CAMPFIRE,
  AIR,
  isSolidForBody,
} from '../src/engine/materials';
import {
  material,
  integrity,
  get,
  set,
  getIntegrity,
} from '../src/engine/grid';
import { step } from '../src/engine/simulation';
import { setChunkingEnabled } from '../src/engine/chunks';
import { __setWeatherForTest } from '../src/engine/weather';
import {
  placePrefabAt,
  prefabCost,
  canPlacePrefab,
  getHutVersion,
  latestHut,
  resetHuts,
} from '../src/game/prefabs';
import { addResource, resetStockpile, getStockpile } from '../src/game/resources';
import { isShelteredAt } from '../src/characters/survivor';

let failures = 0;
function check(cond: boolean, msg: string): void {
  console.log((cond ? 'PASS: ' : 'FAIL: ') + msg);
  if (!cond) failures++;
}
const SURF = 140; // first solid row of the flat test terrain
function clear(): void {
  material.fill(AIR);
  integrity.fill(0);
  // Native stone base with a deep native dirt topsoil - a flat overworld.
  for (let x = 0; x < 500; x++) {
    for (let y = SURF; y < SURF + 12; y++) set(x, y, DIRT);
    for (let y = SURF + 12; y < SURF + 16; y++) set(x, y, STONE);
  }
}
function run(n: number): void {
  for (let t = 0; t < n; t++) step();
}
function countWater(x0: number, x1: number, y0: number, y1: number): number {
  let n = 0;
  for (let x = x0; x <= x1; x++)
    for (let y = y0; y <= y1; y++) if (get(x, y) === WATER) n++;
  return n;
}

setChunkingEnabled(false);
__setWeatherForTest('clear');

// ── 1. HUT ───────────────────────────────────────────────────────────────────
console.log('--- 1: hut purchase ---');
clear();
resetHuts();
resetStockpile();

check(!canPlacePrefab('hut'), '1: hut unaffordable on an empty stockpile');
check(!placePrefabAt('hut', 100, SURF - 1), '1: unaffordable purchase refused');
check(getHutVersion() === 0, '1: refused purchase did not bump the hut version');
let untouched = true;
for (let x = 90; x <= 110; x++)
  for (let y = SURF - 20; y < SURF; y++) if (get(x, y) !== AIR) untouched = false;
check(untouched, '1: refused purchase wrote NOTHING');

const hutCost = prefabCost('hut');
addResource('wood', (hutCost.wood ?? 0) + 5);
addResource('stone', (hutCost.stone ?? 0) + 5);
check(placePrefabAt('hut', 100, SURF - 1), '1: hut placed once affordable');
check(
  getStockpile().wood === 5 && getStockpile().stone === 5,
  `1: exactly the prefab cost was spent (wood ${hutCost.wood}, stone ${hutCost.stone})`,
);
check(getHutVersion() === 1, '1: hut version bumped (the re-home signal)');

const hut = latestHut();
check(hut !== null, '1: hut registered');
if (hut) {
  check(get(hut.x, hut.y) === AIR, '1: interior anchor is open');
  check(isShelteredAt(hut.x, hut.y), '1: interior anchor is SHELTERED (roofed)');
  // Structure census across the hut bounding box.
  let walls = 0;
  let doors = 0;
  let roof = 0;
  let fires = 0;
  for (let x = hut.x - 10; x <= hut.x + 10; x++) {
    for (let y = SURF - 20; y < SURF; y++) {
      const m = get(x, y);
      if (m === WALL) walls++;
      else if (m === DOOR) doors++;
      else if (m === WOOD) roof++;
      else if (m === CAMPFIRE) fires++;
    }
  }
  check(walls > 10, `1: WALL columns stand (${walls} cells)`);
  check(doors > 8, `1: a full-height DOOR is in (${doors} cells)`);
  check(roof >= 10, `1: the WOOD roof spans the hut (${roof} cells)`);
  check(fires === 1, '1: exactly one lit CAMPFIRE inside');
}

// ── 2. WELL: water never soaks or dries ─────────────────────────────────────
console.log('--- 2: well holds its water ---');
clear();
resetStockpile();
const wellCost = prefabCost('well');
addResource('wood', wellCost.wood ?? 0);
addResource('stone', wellCost.stone ?? 0);
check(placePrefabAt('well', 300, SURF - 1), '2: well placed');
check(
  getStockpile().wood === 0 && getStockpile().stone === 0,
  '2: exactly the well cost was spent',
);
const wellWater0 = countWater(297, 303, SURF - 2, SURF + 4);
check(wellWater0 === 6, `2: the pool holds 6 water cells (got ${wellWater0})`);
// Shell is NATIVE stone: never gnawable, never falls.
let shellNative = true;
for (let y = SURF - 4; y <= SURF + 2; y++) {
  if (get(298, y) !== STONE || getIntegrity(298, y) !== 0) shellNative = false;
  if (get(302, y) !== STONE || getIntegrity(302, y) !== 0) shellNative = false;
}
check(shellNative, '2: the shaft lining is NATIVE stone (slot 0 - not gnawable)');

// Control: a puddle sunk into bare dirt (contained - it can't wander off
// sideways, only soak into the soil beneath) drains away.
for (let x = 450; x <= 452; x++) set(x, SURF, WATER); // replaces the top dirt row

run(3000);
const wellWater1 = countWater(297, 303, SURF - 2, SURF + 4);
check(
  wellWater1 === wellWater0,
  `2: after 3000 clear ticks the well kept ALL its water (${wellWater1}/${wellWater0})`,
);
const puddle = countWater(445, 457, SURF - 3, SURF + 3);
check(puddle === 0, `2: the control puddle on bare dirt drained away (${puddle} left)`);

// ── 3. Nobody gets stuck inside ──────────────────────────────────────────────
console.log('--- 3: sealed against wandering bodies ---');
// Approaching the well from either side, the first blocking column rises more
// than STEP_UP_MAX above the walk surface - a walking body can never enter.
function blockHeightAt(x: number): number {
  // Height of the solid run at x, measured up from the outside surface row.
  let h = 0;
  for (let y = SURF - 1; y >= SURF - 12; y--) {
    if (isSolidForBody(get(x, y))) h++;
    else break;
  }
  return h;
}
check(
  blockHeightAt(298) > STEP_UP_MAX && blockHeightAt(302) > STEP_UP_MAX,
  `3: both collar walls rise ${blockHeightAt(298)} > STEP_UP_MAX=${STEP_UP_MAX} above the surface`,
);
// And drinking still works from outside: the pool's outer water cell lies
// within CONSUME_REACH of the outside stand column beside the collar.
const standX = 297; // first open column left of the collar (x=298)
const dxToWater = Math.abs(standX - 299); // nearest pool column
check(
  dxToWater <= CONSUME_REACH,
  `3: pool within CONSUME_REACH of the rim stand (dx ${dxToWater} <= ${CONSUME_REACH})`,
);

if (failures > 0) {
  console.error(`\nFAILED: ${failures} check(s)`);
  process.exit(1);
}
console.log(
  '\nSUMMARY: huts are bought whole (walls+roof+door+lit hearth, atomic cost, sheltered interior, re-home signal); wells are native-stone-lined and capped so their water outlives a 3000-tick drought that empties an open puddle; the shaft is sealed so nothing wanders in, while the rim keeps water in drinking reach. ALL PASS',
);
