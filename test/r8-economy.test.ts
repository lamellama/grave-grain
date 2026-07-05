declare const process: any;
/**
 * r8-economy.test.ts - playtest v0.10 round 8, economy + pacing (GDD 6.1/8).
 *
 * Done-when:
 *   1. STOCKPILE MEAL - with no wild foliage in range, a hungry survivor walks
 *      to the stockpile point, eats ONE stored ration (atomic spend), and its
 *      hunger restores. Stored forager food now feeds the colony.
 *   2. ATOMIC RATION - two hungry survivors, ONE ration: exactly one eats; the
 *      other keeps seeking (no double-spend, no negative stockpile).
 *   3. WILD PREFERRED - reachable foliage is eaten FIRST; the stockpile is the
 *      fallback larder, not the default pantry.
 *   4. FAMINE PRESERVED - no foliage, no stockpile: starvation still kills
 *      (cause 'starvation'), so the larder does not remove the failure state.
 *   5. PACING PINS - BUILD_TICKS=40 (playtest "building is quite slow") and
 *      halved need rates HUNGER_RATE=0.005 / THIRST_RATE=0.0075 (playtest
 *      "survivors die quickly").
 */

import {
  WORLD_W,
  P3_GROUND_Y,
  NEED_MAX,
  HUNGER_THRESHOLD,
  HUNGER_RATE,
  THIRST_RATE,
  BUILD_TICKS,
  EAT_RESTORE,
} from '../src/config';
import { STONE, FOLIAGE, AIR } from '../src/engine/materials';
import { material, integrity, set, get } from '../src/engine/grid';
import { rebuildNavgrid } from '../src/engine/navgrid';
import { createSurvivor, updateSurvivor } from '../src/characters/survivor';
import {
  resetStockpile,
  addResource,
  getStockpile,
  setStockpilePoint,
} from '../src/game/resources';
import { __setWeatherForTest } from '../src/engine/weather';

let failures = 0;
function check(cond: boolean, msg: string): void {
  console.log((cond ? 'PASS: ' : 'FAIL: ') + msg);
  if (!cond) failures++;
}

__setWeatherForTest('clear');

const FLOOR = P3_GROUND_Y;
const FEET = FLOOR - 1;

function flatWorld(): void {
  material.fill(AIR);
  integrity.fill(0);
  for (let x = 0; x < WORLD_W; x++) set(x, FLOOR, STONE);
  rebuildNavgrid();
  resetStockpile();
}

/** Tick a survivor with thirst/warmth topped so only HUNGER drives it. */
function hungryTick(list: ReturnType<typeof createSurvivor>[]): void {
  for (const s of list) {
    s.needs.thirst = NEED_MAX;
    s.needs.warmth = NEED_MAX;
  }
  for (const s of list) updateSurvivor(s, []);
}

// ===========================================================================
// 1. STOCKPILE MEAL - stored food feeds a hungry survivor.
// ===========================================================================
console.log('\n=== 1 hungry survivor eats from the stockpile ===');
{
  flatWorld(); // NO foliage anywhere
  setStockpilePoint(320, FEET);
  addResource('food', 3);
  const s = createSurvivor(290, FEET); // 30 cells from the larder
  s.needs.hunger = HUNGER_THRESHOLD - 5; // below threshold -> seekFood
  let ate = -1;
  for (let t = 0; t < 4000 && ate < 0; t++) {
    hungryTick([s]);
    if (s.needs.hunger > HUNGER_THRESHOLD) ate = t;
  }
  check(ate >= 0, `hunger restored above threshold via a stockpile meal (tick ${ate})`);
  check(getStockpile().food === 2, `exactly one ration spent (3 -> ${getStockpile().food})`);
  check(s.body.alive, 'survivor alive and fed');
}

// ===========================================================================
// 2. ATOMIC RATION - one ration, two mouths.
// ===========================================================================
console.log('\n=== 2 one ration, two hungry survivors ===');
{
  flatWorld();
  setStockpilePoint(320, FEET);
  addResource('food', 1);
  const a = createSurvivor(310, FEET);
  const b = createSurvivor(330, FEET);
  a.needs.hunger = HUNGER_THRESHOLD - 5;
  b.needs.hunger = HUNGER_THRESHOLD - 5;
  for (let t = 0; t < 3000; t++) hungryTick([a, b]);
  const fedCount = [a, b].filter(s => s.needs.hunger > HUNGER_THRESHOLD - 10).length;
  check(getStockpile().food === 0, 'the single ration was spent');
  check(fedCount === 1, `exactly ONE survivor got the ration (fed=${fedCount})`);
  check(a.body.alive && b.body.alive, 'both still alive (the other keeps seeking)');
}

// ===========================================================================
// 3. WILD PREFERRED - a reachable bush beats the larder.
// ===========================================================================
console.log('\n=== 3 wild foliage preferred over the stockpile ===');
{
  flatWorld();
  setStockpilePoint(320, FEET);
  addResource('food', 3);
  set(295, FEET, FOLIAGE); // a bush right next to the survivor
  const s = createSurvivor(292, FEET);
  s.needs.hunger = HUNGER_THRESHOLD - 5;
  let ate = -1;
  for (let t = 0; t < 2000 && ate < 0; t++) {
    hungryTick([s]);
    if (s.needs.hunger > HUNGER_THRESHOLD) ate = t;
  }
  check(ate >= 0, 'survivor fed');
  check(get(295, FEET) === AIR, 'the WILD bush was eaten');
  check(getStockpile().food === 3, 'the stockpile was left untouched');
}

// ===========================================================================
// 4. FAMINE PRESERVED - empty world, empty larder -> starvation still kills.
// ===========================================================================
console.log('\n=== 4 genuine famine still kills ===');
{
  flatWorld();
  setStockpilePoint(320, FEET);
  const s = createSurvivor(300, FEET);
  s.needs.hunger = 3; // nearly starved already
  let died = -1;
  for (let t = 0; t < 30000 && died < 0; t++) {
    hungryTick([s]);
    if (!s.body.alive) died = t;
  }
  check(died >= 0, `starved with nothing to eat (tick ${died})`);
  check(s.deathCause === 'starvation', `cause is starvation (got '${s.deathCause}')`);
}

// ===========================================================================
// 5. PACING PINS (v0.10 balance pass).
// ===========================================================================
console.log('\n=== 5 balance pins ===');
check(BUILD_TICKS === 40, `BUILD_TICKS is 40 (got ${BUILD_TICKS})`);
check(HUNGER_RATE === 0.005, `HUNGER_RATE halved to 0.005 (got ${HUNGER_RATE})`);
check(THIRST_RATE === 0.0075, `THIRST_RATE halved to 0.0075 (got ${THIRST_RATE})`);
check(EAT_RESTORE > HUNGER_THRESHOLD / 2, 'a meal restores a meaningful chunk of hunger');

console.log('\n' + (failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'));
process.exit(failures === 0 ? 0 : 1);
