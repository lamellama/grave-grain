/**
 * T1 verification — Weather & Temperature config seeds + SNOW material row.
 * Run via: tsc (CommonJS) -> node. See tsconfig.weather-config.json.
 *
 * Asserts:
 *  1. SNOW id === 16 and its material table entry has correct flags + light density.
 *  2. All new config constants exported with expected values / types.
 */

import {
  SNOW, SAND, MATERIALS,
} from '../src/engine/materials';

import {
  DENSITY_SNOW, DENSITY_SAND,
  WEATHER_ENABLED, WEATHER_RNG_SEED, SIM_RNG_SEED,
  WEATHER_CLEAR_MIN_TICKS, WEATHER_CLEAR_MAX_TICKS,
  WEATHER_RAIN_MIN_TICKS,  WEATHER_RAIN_MAX_TICKS,
  WEATHER_SNOW_MIN_TICKS,  WEATHER_SNOW_MAX_TICKS,
  WEATHER_TO_RAIN_CHANCE,  WEATHER_TO_SNOW_CHANCE,
  RAIN_SPAWN_CHANCE,       SNOW_SPAWN_CHANCE,
  WEATHER_SKY_ROW,
  TEMP_CLEAR, TEMP_RAIN,   TEMP_SNOW,
  COLD_THRESHOLD,
  SNOW_MELT_CHANCE,
  GROW_RAIN_SPEEDUP,
  WEATHER_SKY_DARKEN_RAIN, WEATHER_SKY_DARKEN_SNOW,
  RAIN_STREAK_COLOR,       SNOW_FLECK_COLOR,
  WEATHER_OVERLAY_DENSITY,
} from '../src/config';

let pass = true;
function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error('FAIL:', msg);
    pass = false;
  } else {
    console.log('ok  :', msg);
  }
}

// ---------------------------------------------------------------------------
// 1. SNOW material id and table entry
// ---------------------------------------------------------------------------
assert(SNOW === 16, 'SNOW === 16');

const snowMat = MATERIALS[SNOW];
assert(snowMat !== undefined,               'MATERIALS[SNOW] entry exists');
assert(snowMat.name === 'snow',             'MATERIALS[SNOW].name === "snow"');
assert(snowMat.isFluid === false,           'MATERIALS[SNOW].isFluid === false');
assert(snowMat.isStatic === false,          'MATERIALS[SNOW].isStatic === false');
assert(snowMat.flammable === false,         'MATERIALS[SNOW].flammable === false');
assert(snowMat.permeableToBodies === false, 'MATERIALS[SNOW].permeableToBodies === false');
assert(snowMat.hasIntegrity === false,      'MATERIALS[SNOW].hasIntegrity === false');

// SNOW density must be lighter (numerically lower) than SAND
const sandDensity = MATERIALS[SAND].density;
assert(snowMat.density < sandDensity, `SNOW density (${snowMat.density}) < SAND density (${sandDensity})`);
assert(DENSITY_SNOW < DENSITY_SAND,   `config DENSITY_SNOW (${DENSITY_SNOW}) < DENSITY_SAND (${DENSITY_SAND})`);

// SNOW id should be one past the previous max (SAPLING=15) and within bounds.
// (No longer the LAST entry: VS-2 added CAMPFIRE at id 17 after it.)
assert(SNOW === 16, 'SNOW id === 16 (contiguous, one past SAPLING=15)');
assert(SNOW < MATERIALS.length, 'SNOW id within MATERIALS bounds (CAMPFIRE=17 now follows)');

// ---------------------------------------------------------------------------
// 2. Config constants — values and types
// ---------------------------------------------------------------------------

// General
assert(WEATHER_ENABLED === true,  'WEATHER_ENABLED === true');
assert(WEATHER_RNG_SEED === 0x00C0FFEE, 'WEATHER_RNG_SEED === 0x00C0FFEE');
assert((WEATHER_RNG_SEED as number) !== (SIM_RNG_SEED as number), 'WEATHER_RNG_SEED distinct from SIM_RNG_SEED');

// Duration bounds — sanity: min < max
assert(WEATHER_CLEAR_MIN_TICKS === 2400, 'WEATHER_CLEAR_MIN_TICKS === 2400');
assert(WEATHER_CLEAR_MAX_TICKS === 5400, 'WEATHER_CLEAR_MAX_TICKS === 5400');
assert(WEATHER_CLEAR_MIN_TICKS < WEATHER_CLEAR_MAX_TICKS, 'clear min < max');
assert(WEATHER_RAIN_MIN_TICKS === 1200,  'WEATHER_RAIN_MIN_TICKS === 1200');
assert(WEATHER_RAIN_MAX_TICKS === 3000,  'WEATHER_RAIN_MAX_TICKS === 3000');
assert(WEATHER_RAIN_MIN_TICKS < WEATHER_RAIN_MAX_TICKS,   'rain min < max');
assert(WEATHER_SNOW_MIN_TICKS === 1200,  'WEATHER_SNOW_MIN_TICKS === 1200');
assert(WEATHER_SNOW_MAX_TICKS === 3000,  'WEATHER_SNOW_MAX_TICKS === 3000');
assert(WEATHER_SNOW_MIN_TICKS < WEATHER_SNOW_MAX_TICKS,   'snow min < max');

// Transition chances — sum to ≤ 1.0 (else-clear branch makes up the rest)
assert(WEATHER_TO_RAIN_CHANCE === 0.5, 'WEATHER_TO_RAIN_CHANCE === 0.5');
assert(WEATHER_TO_SNOW_CHANCE === 0.3, 'WEATHER_TO_SNOW_CHANCE === 0.3');
assert(WEATHER_TO_RAIN_CHANCE + WEATHER_TO_SNOW_CHANCE <= 1.0, 'transition chances sum ≤ 1');

// Spawn chances
assert(RAIN_SPAWN_CHANCE === 0.03, 'RAIN_SPAWN_CHANCE === 0.03');
assert(SNOW_SPAWN_CHANCE === 0.02, 'SNOW_SPAWN_CHANCE === 0.02');

// Sky row
assert(WEATHER_SKY_ROW === 0, 'WEATHER_SKY_ROW === 0');

// Temperatures — TEMP_SNOW < TEMP_RAIN < TEMP_CLEAR
assert(TEMP_SNOW < TEMP_RAIN,   `TEMP_SNOW (${TEMP_SNOW}) < TEMP_RAIN (${TEMP_RAIN})`);
assert(TEMP_RAIN < TEMP_CLEAR,  `TEMP_RAIN (${TEMP_RAIN}) < TEMP_CLEAR (${TEMP_CLEAR})`);
assert(TEMP_CLEAR === 10, 'TEMP_CLEAR === 10');
assert(TEMP_RAIN  === 2,  'TEMP_RAIN  === 2');
assert(TEMP_SNOW  === -8, 'TEMP_SNOW  === -8');

// COLD_THRESHOLD between TEMP_RAIN and TEMP_CLEAR
assert(COLD_THRESHOLD > TEMP_RAIN && COLD_THRESHOLD < TEMP_CLEAR,
  `COLD_THRESHOLD (${COLD_THRESHOLD}) is between TEMP_RAIN (${TEMP_RAIN}) and TEMP_CLEAR (${TEMP_CLEAR})`);

// Other scalars
assert(SNOW_MELT_CHANCE === 0.5,         'SNOW_MELT_CHANCE === 0.5');
assert(GROW_RAIN_SPEEDUP === 2,           'GROW_RAIN_SPEEDUP === 2');
assert(WEATHER_OVERLAY_DENSITY === 120,   'WEATHER_OVERLAY_DENSITY === 120');

// String colour constants — just check they are non-empty strings
assert(typeof WEATHER_SKY_DARKEN_RAIN === 'string' && WEATHER_SKY_DARKEN_RAIN.length > 0,
  'WEATHER_SKY_DARKEN_RAIN is a non-empty string');
assert(typeof WEATHER_SKY_DARKEN_SNOW === 'string' && WEATHER_SKY_DARKEN_SNOW.length > 0,
  'WEATHER_SKY_DARKEN_SNOW is a non-empty string');
assert(typeof RAIN_STREAK_COLOR === 'string' && RAIN_STREAK_COLOR.length > 0,
  'RAIN_STREAK_COLOR is a non-empty string');
assert(typeof SNOW_FLECK_COLOR === 'string' && SNOW_FLECK_COLOR.length > 0,
  'SNOW_FLECK_COLOR is a non-empty string');

// ---------------------------------------------------------------------------
console.log(pass ? '\nALL PASS' : '\nFAIL');
if (!pass) throw new Error('weather-config assertions failed');
