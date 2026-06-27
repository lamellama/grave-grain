/**
 * Headless verification for VS-2 Task T-C - the CAMPFIRE (managed contained
 * fire, GDD 8/6.1). Imports the REAL modules (no mocks). Run via tsc -> node.
 *
 * A campfire is a long-burning HEAT SOURCE that warms survivors like FIRE but,
 * unlike raw spreading FIRE, NEVER spreads to flammable neighbours and is NEVER
 * fled - so it warms a camp without eating structures.
 *
 * Covers:
 *   1. effectiveTemp: a campfire within FIRE_WARMTH_RADIUS adds FIRE_WARMTH_BONUS
 *      (>= COLD_THRESHOLD - it stops the cold).
 *   2. WARMS + NOT FLED: a cold survivor by a campfire stays warm, never freezes,
 *      and never enters 'fleeFire' (flee keys on FIRE only).
 *   3. NO SPREAD / structure-safe: a campfire next to WOOD never ignites it (no
 *      FIRE ever appears) over a long sim run.
 *   4. BURNS LONG then ASH: outlasts FIRE_LIFETIME by far, and on fuel-out the
 *      cell becomes ASH (not an eternal flame).
 */
import {
  WORLD_W,
  NEED_MAX,
  FIRE_LIFETIME,
  FIRE_WARMTH_BONUS,
  COLD_THRESHOLD,
  TEMP_SNOW,
  CAMPFIRE_FUEL,
} from '../src/config';
import { CAMPFIRE, FIRE, WOOD, STONE, ASH } from '../src/engine/materials';
import { material, integrity, set, idx } from '../src/engine/grid';
import { step, resetChunks } from '../src/engine/simulation';
import {
  createSurvivor,
  updateSurvivor,
  effectiveTemp,
} from '../src/characters/survivor';
import { __setWeatherForTest } from '../src/engine/weather';

function fail(msg: string): never {
  console.log('FAIL:', msg);
  throw new Error(msg);
}
function ok(msg: string): void {
  console.log('PASS:', msg);
}
function clearGrid(): void {
  material.fill(0);
  integrity.fill(0);
}
function floor(row: number): void {
  for (let x = 0; x < WORLD_W; x++) set(x, row, STONE);
}
function wall(x: number, y0: number, y1: number): void {
  for (let y = y0; y <= y1; y++) set(x, y, STONE);
}
function countMaterial(m: number): number {
  let n = 0;
  for (let i = 0; i < material.length; i++) if (material[i] === m) n++;
  return n;
}

// ============================================================================
// 1. effectiveTemp composition (cold world, campfire in range).
// ============================================================================
__setWeatherForTest('snow');
clearGrid();
floor(150);
set(206, 149, CAMPFIRE); // Chebyshev 6 from feet at (200,149) -> within radius
{
  const s = createSurvivor(200, 149);
  const t = effectiveTemp(s.body);
  if (t !== TEMP_SNOW + FIRE_WARMTH_BONUS)
    fail(`efftemp: campfire effTemp ${t} != ${TEMP_SNOW + FIRE_WARMTH_BONUS}`);
  if (t < COLD_THRESHOLD) fail('efftemp: campfire did not lift effTemp to COLD_THRESHOLD');
  ok(`effectiveTemp: campfire = ambient + FIRE_WARMTH_BONUS (${t}, >= COLD_THRESHOLD)`);
}

// ============================================================================
// 2. WARMS and is NOT FLED. Penned cold survivor next to a campfire: warmth
//    holds near full, it never freezes, and never flees. (No sim.step here -
//    updateSurvivor does not run the sand sim, so the campfire cell persists.)
// ============================================================================
__setWeatherForTest('snow');
clearGrid();
floor(150);
wall(196, 138, 149);
wall(203, 138, 149); // pen so the survivor cannot wander out of warmth range
set(206, 149, CAMPFIRE);
{
  const s = createSurvivor(200, 149);
  let everFled = false;
  let minWarmth = NEED_MAX;
  for (let t = 0; t < 4000; t++) {
    // top hunger/thirst so warmth is the only thing under test
    s.needs.hunger = NEED_MAX;
    s.needs.thirst = NEED_MAX;
    updateSurvivor(s, []);
    if (s.behaviour === 'fleeFire') everFled = true;
    if (s.needs.warmth < minWarmth) minWarmth = s.needs.warmth;
    if (!s.body.alive) fail(`warms: survivor died by a campfire (cause=${s.deathCause}) at tick ${t}`);
  }
  if (everFled) fail('warms: survivor FLED the campfire (must never flee a campfire)');
  if (minWarmth < WARMTH_THRESHOLD_FLOOR())
    fail(`warms: warmth dipped to ${minWarmth.toFixed(1)} by a campfire (should stay high)`);
  ok(`WARMS + not fled: cold survivor stays warm by a campfire (min warmth ${minWarmth.toFixed(1)}, alive, never fled)`);
}
function WARMTH_THRESHOLD_FLOOR(): number {
  // It should never even approach the freeze; require it to stay well above half.
  return NEED_MAX * 0.75;
}

// ============================================================================
// 3. NO SPREAD / structure-safe. WOOD orthogonally adjacent to a campfire must
//    never ignite (no FIRE cell ever appears) over a long sim run. Clear weather
//    so no precipitation noise.
// ============================================================================
__setWeatherForTest('clear');
clearGrid();
floor(150);
set(100, 149, CAMPFIRE);
set(101, 149, WOOD); // touching the campfire
set(99, 149, WOOD);
set(100, 148, WOOD); // directly above
resetChunks(); // wake all chunks so the sim visits the scene
{
  const woodBefore = countMaterial(WOOD);
  for (let t = 0; t < 400; t++) step();
  const fireCells = countMaterial(FIRE);
  const woodAfter = countMaterial(WOOD);
  if (fireCells !== 0) fail(`no-spread: ${fireCells} FIRE cell(s) appeared - campfire must not spread`);
  if (woodAfter !== woodBefore)
    fail(`no-spread: WOOD count changed ${woodBefore} -> ${woodAfter} - campfire consumed structure`);
  if (material[idx(100, 149)] !== CAMPFIRE)
    fail('no-spread: campfire did not survive 400 ticks (should outlast FIRE_LIFETIME by far)');
  ok(`NO SPREAD: campfire next to WOOD ignites nothing over 400 ticks (0 FIRE, WOOD intact)`);
}

// ============================================================================
// 4. BURNS LONG then -> ASH. Outlasts FIRE_LIFETIME; on fuel-out becomes ASH.
//    We seed full fuel (proving "long"), then force low fuel to reach burnout
//    deterministically without thousands of steps.
// ============================================================================
__setWeatherForTest('clear');
clearGrid();
floor(150);
const CF = idx(300, 149);
set(300, 149, CAMPFIRE);
resetChunks();
{
  step(); // first visit seeds the fuel countdown
  if (material[CF] !== CAMPFIRE) fail('burns: campfire vanished on first tick');
  if (integrity[CF] !== CAMPFIRE_FUEL)
    fail(`burns: fuel not seeded to CAMPFIRE_FUEL (${integrity[CF]} != ${CAMPFIRE_FUEL})`);
  // Still burning well past a raw fire's whole lifetime.
  for (let t = 0; t < FIRE_LIFETIME * 3; t++) step();
  if (material[CF] !== CAMPFIRE)
    fail(`burns: campfire burned out within ${FIRE_LIFETIME * 3} ticks (not "long")`);
  ok(`BURNS LONG: still alight after ${FIRE_LIFETIME * 3} ticks (>> FIRE_LIFETIME ${FIRE_LIFETIME})`);

  // Force near-empty fuel so we hit burnout in a bounded loop.
  integrity[CF] = 1;
  let burnoutTick = -1;
  for (let t = 0; t < 3000 && burnoutTick < 0; t++) {
    step();
    if (material[CF] !== CAMPFIRE) burnoutTick = t;
  }
  if (burnoutTick < 0) fail('burns: campfire never burned out with fuel forced to 1');
  const finalMat: number = material[CF];
  if (finalMat !== ASH) fail(`burns: campfire expired to ${finalMat} (expected ASH ${ASH})`);
  if (integrity[CF] !== 0) fail(`burns: reused fuel slot not cleared on expiry (${integrity[CF]})`);
  ok(`BURNS OUT -> ASH: fuel-out leaves ASH, slot cleared (burnout ${burnoutTick} ticks after fuel=1)`);
}

console.log('\nALL PASS');
console.log(
  'SUMMARY: a campfire adds FIRE_WARMTH_BONUS to effective temp and warms a penned cold survivor (never freezes, never fled); it never spreads to adjacent WOOD (0 FIRE); it burns far longer than FIRE_LIFETIME and expires cleanly to ASH.',
);
