/**
 * Headless verification for VS-2 Task T-B - LOCAL effective temperature (GDD
 * 6.1/10/13). Imports the REAL modules (no mocks). Run via tsc (commonjs) -> node.
 *
 * Effective temp = ambient (VS-1 weather) + FIRE_WARMTH_BONUS (near fire) +
 * SHELTER_WARMTH_BONUS (under a roof) - SNOW_CONTACT_PENALTY (in water/snow). It
 * is a single per-survivor scalar, re-sampled on an interval (WARMTH_SAMPLE_TICKS,
 * perf - NOT a per-cell grid), and it drives the warmth drain/refill: below
 * COLD_THRESHOLD warmth drains, faster the colder it is.
 *
 * Covers:
 *   1. INVARIANTS: fire/shelter bonuses lift the coldest ambient at/above
 *      COLD_THRESHOLD (so they reliably stop the cold); span calibration.
 *   2. effectiveTemp composition: exposed / +fire / +shelter / -contact.
 *   3. GRADED drain: a colder survivor (water/snow contact) loses warmth faster
 *      than a plain-cold one (wetness pinned out, so only effTemp differs).
 *   4. INTERVAL: effTemp is cached - a change mid-interval is not seen until the
 *      next sample WARMTH_SAMPLE_TICKS later.
 */
import {
  WORLD_W,
  NEED_MAX,
  WARMTH_RATE,
  WARMTH_SAMPLE_TICKS,
  FIRE_WARMTH_BONUS,
  SHELTER_WARMTH_BONUS,
  SNOW_CONTACT_PENALTY,
  WARMTH_COLD_SPAN,
  WARMTH_COLD_FACTOR_MIN,
  WARMTH_COLD_FACTOR_MAX,
  COLD_THRESHOLD,
  TEMP_SNOW,
} from '../src/config';
import { FIRE, WATER, WOOD, STONE } from '../src/engine/materials';
import { material, set } from '../src/engine/grid';
import type { Body } from '../src/characters/body';
import {
  createSurvivor,
  updateSurvivor,
  effectiveTemp,
  type Survivor,
} from '../src/characters/survivor';
import { __setWeatherForTest } from '../src/engine/weather';

// Pin the world cold (snow) for every scenario - effectiveTemp reads ambient
// from getTemperature(), and updateSurvivor never advances the weather machine.
__setWeatherForTest('snow');

function fail(msg: string): never {
  console.log('FAIL:', msg);
  throw new Error(msg);
}
function ok(msg: string): void {
  console.log('PASS:', msg);
}
function clearGrid(): void {
  material.fill(0);
}
function floor(row: number): void {
  for (let x = 0; x < WORLD_W; x++) set(x, row, STONE);
}
/** Vertical STONE wall in column x, rows [y0, y1] inclusive (a pen side). */
function wall(x: number, y0: number, y1: number): void {
  for (let y = y0; y <= y1; y++) set(x, y, STONE);
}
function approx(a: number, b: number, tol: number): boolean {
  return Math.abs(a - b) <= tol;
}

// ============================================================================
// 1. INVARIANTS (cheap gate).
// ============================================================================
if (TEMP_SNOW + FIRE_WARMTH_BONUS < COLD_THRESHOLD)
  fail(`invariant: fire bonus does not lift snow (${TEMP_SNOW}+${FIRE_WARMTH_BONUS}) to COLD_THRESHOLD (${COLD_THRESHOLD})`);
if (TEMP_SNOW + SHELTER_WARMTH_BONUS < COLD_THRESHOLD)
  fail(`invariant: shelter bonus does not lift snow to COLD_THRESHOLD`);
if (SNOW_CONTACT_PENALTY <= 0) fail('invariant: SNOW_CONTACT_PENALTY must be > 0');
if (WARMTH_COLD_SPAN !== COLD_THRESHOLD - TEMP_SNOW)
  fail(`invariant: WARMTH_COLD_SPAN (${WARMTH_COLD_SPAN}) != COLD_THRESHOLD-TEMP_SNOW (${COLD_THRESHOLD - TEMP_SNOW}) -> snow exposure not calibrated to coldFactor 1.0`);
ok('invariants: fire/shelter bonuses stop the cold; span calibrated so snow exposure = 1.0x drain');

// ============================================================================
// 2. effectiveTemp composition. Feet at (200,149); footprint x ~[197,202],
//    y ~[138,150].
// ============================================================================
clearGrid();
floor(150);
{
  const exposed = createSurvivor(200, 149);
  const tExposed = effectiveTemp(exposed.body);
  if (!approx(tExposed, TEMP_SNOW, 0.001))
    fail(`compose: exposed effTemp ${tExposed} != ambient ${TEMP_SNOW}`);
  ok(`compose: exposed = ambient (${tExposed})`);
}
{
  // FIRE at Chebyshev 6 from feet (<= FIRE_WARMTH_RADIUS, NOT adjacent -> no
  // ignition), as in p12-warmth R2.
  clearGrid();
  floor(150);
  set(206, 149, FIRE);
  const s = createSurvivor(200, 149);
  const t = effectiveTemp(s.body);
  if (!approx(t, TEMP_SNOW + FIRE_WARMTH_BONUS, 0.001))
    fail(`compose: +fire effTemp ${t} != ${TEMP_SNOW + FIRE_WARMTH_BONUS}`);
  if (t < COLD_THRESHOLD) fail('compose: +fire did not reach COLD_THRESHOLD');
  ok(`compose: +fire = ambient + FIRE_WARMTH_BONUS (${t}, >= COLD_THRESHOLD)`);
}
{
  // WOOD roof a few cells above the head (head row ~ 149-(12-1)=138).
  clearGrid();
  floor(150);
  for (let x = 197; x <= 202; x++) set(x, 135, WOOD);
  const s = createSurvivor(200, 149);
  const t = effectiveTemp(s.body);
  if (!approx(t, TEMP_SNOW + SHELTER_WARMTH_BONUS, 0.001))
    fail(`compose: +shelter effTemp ${t} != ${TEMP_SNOW + SHELTER_WARMTH_BONUS}`);
  if (t < COLD_THRESHOLD) fail('compose: +shelter did not reach COLD_THRESHOLD');
  ok(`compose: +shelter = ambient + SHELTER_WARMTH_BONUS (${t}, >= COLD_THRESHOLD)`);
}
{
  // WATER in the footprint (upper-body air cell) -> contact penalty.
  clearGrid();
  floor(150);
  set(200, 145, WATER);
  const s = createSurvivor(200, 149);
  const t = effectiveTemp(s.body);
  if (!approx(t, TEMP_SNOW - SNOW_CONTACT_PENALTY, 0.001))
    fail(`compose: -contact effTemp ${t} != ${TEMP_SNOW - SNOW_CONTACT_PENALTY}`);
  ok(`compose: water/snow contact = ambient - SNOW_CONTACT_PENALTY (${t})`);
}

// ============================================================================
// 3. GRADED drain. A (water contact, colder) must lose warmth faster than B
//    (plain snow). Both penned (cannot wander off), wetness pinned 0 so ONLY
//    the effective-temp grading differs. hunger/thirst topped; warmth free.
// ============================================================================
clearGrid();
floor(150);
{
  // Pens: walls flank each survivor so locomotion is a no-op (mirrors p12-warmth).
  wall(146, 138, 149);
  wall(154, 138, 149);
  wall(296, 138, 149);
  wall(304, 138, 149);
  const A = createSurvivor(150, 149); // colder: water contact
  const B = createSurvivor(300, 149); // plain snow
  set(150, 145, WATER); // in A's footprint box (persists - updateSurvivor never runs the sand sim)
  const w0 = NEED_MAX;
  const N = 200;
  for (let t = 0; t < N; t++) {
    A.needs.hunger = NEED_MAX; A.needs.thirst = NEED_MAX; A.wetness = 0;
    B.needs.hunger = NEED_MAX; B.needs.thirst = NEED_MAX; B.wetness = 0;
    updateSurvivor(A, []);
    updateSurvivor(B, []);
  }
  const dropA = w0 - A.needs.warmth;
  const dropB = w0 - B.needs.warmth;
  // B is pure snow exposure -> coldFactor calibrated to exactly 1.0.
  const expectedB = WARMTH_RATE * N;
  const cfA = Math.min(WARMTH_COLD_FACTOR_MAX, Math.max(WARMTH_COLD_FACTOR_MIN, (COLD_THRESHOLD - (TEMP_SNOW - SNOW_CONTACT_PENALTY)) / WARMTH_COLD_SPAN));
  const expectedA = WARMTH_RATE * cfA * N;
  if (A.smpWetContact !== true) fail('graded: A never registered water contact');
  if (dropB <= 0) fail('graded: B (plain snow) lost no warmth - not cold?');
  if (!approx(dropB, expectedB, 0.5))
    fail(`graded: B drop ${dropB.toFixed(2)} != analytic ${expectedB.toFixed(2)} (snow exposure should be 1.0x)`);
  if (!approx(dropA, expectedA, 0.6))
    fail(`graded: A drop ${dropA.toFixed(2)} != analytic ${expectedA.toFixed(2)} (coldFactor ${cfA.toFixed(3)})`);
  const ratio = dropA / dropB;
  console.log(`R3 warmth drop over ${N}t: A(contact)=${dropA.toFixed(2)} B(snow)=${dropB.toFixed(2)} ratio=${ratio.toFixed(3)} (coldFactor A=${cfA.toFixed(3)})`);
  if (ratio <= 1.1) fail(`graded: contact survivor did not drain meaningfully faster (ratio ${ratio.toFixed(3)})`);
  ok(`GRADED: colder (contact) drains ${ratio.toFixed(2)}x faster than plain snow (= coldFactor ratio)`);
}

// ============================================================================
// 4. INTERVAL caching. effTemp is sampled every WARMTH_SAMPLE_TICKS; a heat
//    source added mid-interval is NOT reflected until the next sample.
// ============================================================================
clearGrid();
floor(150);
{
  wall(196, 138, 149);
  wall(203, 138, 149); // pen so the survivor cannot flee the fire we add
  const s = createSurvivor(200, 149);
  s.needs.hunger = NEED_MAX; s.needs.thirst = NEED_MAX; s.needs.warmth = NEED_MAX;
  updateSurvivor(s, []); // tick 1 -> first sample (exposed, cold)
  if (s.smpEffTemp >= COLD_THRESHOLD) fail(`interval: first sample not cold (${s.smpEffTemp})`);
  const coldSample = s.smpEffTemp;

  // Add a fire within range (Chebyshev 6, not adjacent). Run a few ticks that
  // stay INSIDE the current sample window -> cached value must not change yet.
  set(206, 149, FIRE);
  for (let i = 0; i < 8; i++) {
    s.needs.hunger = NEED_MAX; s.needs.thirst = NEED_MAX; s.needs.warmth = NEED_MAX;
    updateSurvivor(s, []);
  }
  if (!approx(s.smpEffTemp, coldSample, 0.001))
    fail(`interval: effTemp changed mid-window (${s.smpEffTemp}) - caching broken`);
  ok(`INTERVAL: fire added mid-window not yet seen (effTemp still ${s.smpEffTemp})`);

  // Run past the sample interval -> the next sample must pick up the fire.
  for (let i = 0; i < WARMTH_SAMPLE_TICKS + 2; i++) {
    s.needs.hunger = NEED_MAX; s.needs.thirst = NEED_MAX; s.needs.warmth = NEED_MAX;
    updateSurvivor(s, []);
  }
  if (s.smpEffTemp < COLD_THRESHOLD)
    fail(`interval: effTemp did not pick up the fire after a resample (${s.smpEffTemp})`);
  ok(`INTERVAL: next sample picks up the fire (effTemp ${coldSample} -> ${s.smpEffTemp})`);
}

console.log('\nALL PASS');
console.log(
  'SUMMARY: effectiveTemp = ambient + fire + shelter - water/snow contact; fire/shelter reliably clear COLD_THRESHOLD; warmth drains graded (colder = faster, snow exposure calibrated to 1.0x); effTemp is cached and re-sampled only every WARMTH_SAMPLE_TICKS.',
);
