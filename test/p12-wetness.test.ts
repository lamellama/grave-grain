/**
 * Headless verification for VS-2 Task T-A - the WETNESS need (GDD 6.1, the "wet"
 * half of cold-and-wet). Imports the REAL modules (no mocks). Run via tsc
 * (commonjs) -> node.
 *
 * Wetness is a per-survivor float in [0, NEED_MAX] (0 = dry, NEED_MAX = soaked).
 * It is NOT a killing need: it rises in RAIN / on WATER|SNOW contact, dries
 * slowly otherwise (fast by a fire), and makes the cold bite harder by scaling
 * the warmth drain (WET_WARMTH_MULT).
 *
 * Covers:
 *   1. RAIN wets: an exposed survivor in rain gets steadily wetter from 0.
 *   2. DRY: out of the rain (clear, no water/snow) wetness falls back toward 0.
 *   3. WET amplifies cold: a soaked survivor in equal cold loses warmth
 *      ~WET_WARMTH_MULT x faster than an identical dry one.
 *   4. Wetness never kills: a soaked-but-warm survivor does not die.
 */
import {
  WORLD_W,
  NEED_MAX,
  WARMTH_RATE,
  WETNESS_RATE,
  DRY_RATE,
  WET_WARMTH_MULT,
} from '../src/config';
import { STONE } from '../src/engine/materials';
import { material, set } from '../src/engine/grid';
import {
  createSurvivor,
  updateSurvivor,
  type Survivor,
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
}
function floor(row: number): void {
  for (let x = 0; x < WORLD_W; x++) set(x, row, STONE);
}
/** Top up the killing needs so only the property under test can move/kill. */
function topUpNeeds(s: Survivor): void {
  s.needs.hunger = NEED_MAX;
  s.needs.thirst = NEED_MAX;
  s.needs.warmth = NEED_MAX;
}

// ============================================================================
// 1. RAIN wets. Exposed survivor on open ground, weather = rain, wetness from 0
//    rises over time. Keep needs topped so it just stands/wanders in the rain.
// ============================================================================
__setWeatherForTest('rain');
clearGrid();
floor(150);
{
  const s = createSurvivor(200, 149);
  if (s.wetness !== 0) fail(`rain: survivor did not start dry (wetness=${s.wetness})`);
  for (let t = 0; t < 300; t++) {
    topUpNeeds(s);
    updateSurvivor(s, []);
  }
  if (s.wetness <= 10)
    fail(`rain: wetness barely rose after 300 ticks (${s.wetness}); expected steady soak`);
  console.log(`R1 wetness after 300 ticks of rain: ${s.wetness.toFixed(2)}`);
  ok(`RAIN wets an exposed survivor (0 -> ${s.wetness.toFixed(1)} over 300 ticks)`);
}

// ============================================================================
// 2. DRY. Soaked survivor, weather = clear (warm, no water/snow). Wetness must
//    fall back toward 0 (slow ambient dry).
// ============================================================================
__setWeatherForTest('clear');
clearGrid();
floor(150);
{
  const s = createSurvivor(200, 149);
  s.wetness = NEED_MAX;
  for (let t = 0; t < 400; t++) {
    topUpNeeds(s);
    updateSurvivor(s, []);
  }
  if (s.wetness >= NEED_MAX)
    fail(`dry: wetness did not fall from soaked (${s.wetness})`);
  const expectedDrop = DRY_RATE * 400;
  console.log(
    `R2 wetness after 400 dry ticks: ${s.wetness.toFixed(2)} (dropped ~${(NEED_MAX - s.wetness).toFixed(2)}, analytic ~${expectedDrop.toFixed(2)})`,
  );
  ok(`DRY: out of the rain a soaked survivor dries off (${NEED_MAX} -> ${s.wetness.toFixed(1)})`);
}

// ============================================================================
// 3. WET amplifies the cold. Two identical survivors in equal cold (snow state,
//    no fire, no shelter): one pinned SOAKED, one pinned DRY each tick. The wet
//    one must lose warmth ~WET_WARMTH_MULT x faster (the headline T-A effect).
// ============================================================================
__setWeatherForTest('snow');
clearGrid();
floor(150);
{
  const wet = createSurvivor(150, 149);
  const dry = createSurvivor(300, 149);
  const w0 = NEED_MAX;
  const N = 400;
  for (let t = 0; t < N; t++) {
    // Top hunger/thirst only - leave warmth to drain. Pin wetness each tick so
    // wetMult is exactly soaked vs dry when updateSurvivor reads it.
    wet.needs.hunger = NEED_MAX;
    wet.needs.thirst = NEED_MAX;
    dry.needs.hunger = NEED_MAX;
    dry.needs.thirst = NEED_MAX;
    wet.wetness = NEED_MAX;
    dry.wetness = 0;
    updateSurvivor(wet, []);
    updateSurvivor(dry, []);
  }
  const dropWet = w0 - wet.needs.warmth;
  const dropDry = w0 - dry.needs.warmth;
  if (dropDry <= 0) fail(`wet-cold: dry survivor lost no warmth (${dropDry}) - not cold?`);
  if (dropWet <= dropDry)
    fail(`wet-cold: wet (${dropWet.toFixed(2)}) did not out-drain dry (${dropDry.toFixed(2)})`);
  const ratio = dropWet / dropDry;
  console.log(
    `R3 warmth drop over ${N} ticks: wet=${dropWet.toFixed(2)} dry=${dropDry.toFixed(2)} ratio=${ratio.toFixed(3)} (WET_WARMTH_MULT=${WET_WARMTH_MULT})`,
  );
  // Analytic: dropDry = WARMTH_RATE*N, dropWet = WARMTH_RATE*WET_WARMTH_MULT*N.
  const expectedDry = WARMTH_RATE * N;
  if (Math.abs(dropDry - expectedDry) > 0.5)
    fail(`wet-cold: dry drain ${dropDry.toFixed(2)} != analytic ${expectedDry.toFixed(2)}`);
  if (Math.abs(ratio - WET_WARMTH_MULT) > 0.05)
    fail(`wet-cold: ratio ${ratio.toFixed(3)} != WET_WARMTH_MULT ${WET_WARMTH_MULT}`);
  ok(`WET amplifies cold: warmth drains ${ratio.toFixed(2)}x faster soaked (== WET_WARMTH_MULT)`);
}

// ============================================================================
// 4. Wetness never kills directly. Soaked but WARM (clear weather) survivor runs
//    a long time without dying - wetness alone is not a death cause.
// ============================================================================
__setWeatherForTest('clear');
clearGrid();
floor(150);
{
  const s = createSurvivor(200, 149);
  for (let t = 0; t < 3000; t++) {
    s.wetness = NEED_MAX; // keep it soaked the whole run
    s.needs.hunger = NEED_MAX;
    s.needs.thirst = NEED_MAX;
    updateSurvivor(s, []);
  }
  if (!s.body.alive) fail(`no-kill: soaked-but-warm survivor died (cause=${s.deathCause})`);
  if (s.deathCause !== null) fail(`no-kill: deathCause set to ${s.deathCause} by wetness`);
  ok('wetness never kills directly (soaked + warm survives 3000 ticks)');
}

console.log('\nALL PASS');
console.log(
  'SUMMARY: rain soaks an exposed survivor; out of the rain it dries off; a soaked survivor loses warmth WET_WARMTH_MULT x faster in equal cold; wetness alone never kills.',
);
