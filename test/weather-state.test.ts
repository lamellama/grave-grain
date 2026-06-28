declare const process: any;
/**
 * weather-state.test.ts — Weather & Temperature T2 (GDD §10 / §13). Headless
 * Node test over the REAL src/engine/weather.ts module (no mocks).
 *
 * Done-when:
 *   1. DETERMINISM — two independent reset+replay runs over t=0..N produce an
 *      identical sampled (state, temperature) sequence.
 *   2. TEMP ORDERING — temp(snow) < temp(rain) < temp(clear), equal to TEMP_*.
 *   3. DURATIONS IN RANGE — every observed run-length is within that state's
 *      [MIN, MAX] bounds.
 *   4. COLD FLAG — isAmbientColdNow() true in rain/snow, false in clear.
 *   5. BOTH BRANCHES — at least one rain AND one snow occur within N ticks.
 */

import {
  resetWeather,
  updateWeather,
  getWeather,
  getTemperature,
  isAmbientColdNow,
  WeatherState,
} from '../src/engine/weather';
import {
  TEMP_CLEAR,
  TEMP_RAIN,
  TEMP_SNOW,
  WEATHER_CLEAR_MIN_TICKS,
  WEATHER_CLEAR_MAX_TICKS,
  WEATHER_RAIN_MIN_TICKS,
  WEATHER_RAIN_MAX_TICKS,
  WEATHER_SNOW_MIN_TICKS,
  WEATHER_SNOW_MAX_TICKS,
  WEATHER_SNOW_EARLIEST_TICK,
} from '../src/config';

// ---------------------------------------------------------------------------
// Minimal assertion harness
// ---------------------------------------------------------------------------
let totalFailed = 0;
function ok(condition: boolean, message: string): void {
  if (condition) {
    console.log(`  ✓ ${message}`);
  } else {
    console.error(`  ✗ ${message}`);
    totalFailed++;
  }
}
function label(name: string): void {
  console.log(`\n=== ${name} ===`);
}

// Long horizon: snow is gated out of the early game (WEATHER_SNOW_EARLIEST_TICK),
// so we sample far enough past the grace period that a snow phase reliably occurs.
const N = 90000;

interface Sample {
  state: WeatherState;
  temp: number;
  cold: boolean;
}

/** Reset, then step t=0..N, sampling each tick. */
function run(): Sample[] {
  resetWeather();
  const out: Sample[] = [];
  for (let t = 0; t <= N; t++) {
    updateWeather(t);
    out.push({ state: getWeather(), temp: getTemperature(), cold: isAmbientColdNow() });
  }
  return out;
}

// ===========================================================================
// 1. DETERMINISM — two independent runs are identical
// ===========================================================================
label('1 determinism: two reset+replay runs match element-by-element');
const a = run();
const b = run();
let mismatch = -1;
for (let i = 0; i < a.length; i++) {
  if (a[i].state !== b[i].state || a[i].temp !== b[i].temp) {
    mismatch = i;
    break;
  }
}
ok(a.length === b.length && a.length === N + 1, `both runs sampled ${N + 1} ticks`);
ok(mismatch === -1, `sequences are byte-identical (first mismatch at ${mismatch})`);

// ===========================================================================
// 2. TEMP ORDERING — snow < rain < clear, equal to configured values
// ===========================================================================
label('2 temperature ordering equals TEMP_* and orders snow<rain<clear');
const seen: Record<WeatherState, number> = { clear: 0, rain: 0, snow: 0 };
for (const s of a) seen[s.state]++;
// Per-state temp consistency from the sampled stream.
let tempConsistent = true;
for (const s of a) {
  const expect = s.state === 'rain' ? TEMP_RAIN : s.state === 'snow' ? TEMP_SNOW : TEMP_CLEAR;
  if (s.temp !== expect) tempConsistent = false;
}
ok(tempConsistent, 'each sample temp equals its state TEMP_* constant');
ok(TEMP_SNOW < TEMP_RAIN && TEMP_RAIN < TEMP_CLEAR, `temp(snow)<temp(rain)<temp(clear): ${TEMP_SNOW}<${TEMP_RAIN}<${TEMP_CLEAR}`);

// ===========================================================================
// 3. DURATIONS IN RANGE — every run-length within its state's [MIN, MAX]
// ===========================================================================
label('3 every completed run-length within its [MIN, MAX]');
const bounds: Record<WeatherState, [number, number]> = {
  clear: [WEATHER_CLEAR_MIN_TICKS, WEATHER_CLEAR_MAX_TICKS],
  rain: [WEATHER_RAIN_MIN_TICKS, WEATHER_RAIN_MAX_TICKS],
  snow: [WEATHER_SNOW_MIN_TICKS, WEATHER_SNOW_MAX_TICKS],
};
// Build completed runs (exclude the first and last partial runs).
const runs: { state: WeatherState; len: number }[] = [];
let curState = a[0].state;
let curLen = 1;
for (let i = 1; i < a.length; i++) {
  if (a[i].state === curState) {
    curLen++;
  } else {
    runs.push({ state: curState, len: curLen });
    curState = a[i].state;
    curLen = 1;
  }
}
// First run starts at t=0 (a true reset start, full duration); the LAST run is
// truncated by the sample horizon N, so drop it.
const completed = runs.slice(0, -1);
let allInRange = true;
let offender = '';
for (const r of completed) {
  const [lo, hi] = bounds[r.state];
  // CLEAR can SELF-REPEAT: a clear->clear roll (the ~20% "stay clear" branch)
  // re-rolls a fresh clear duration, so consecutive clears read as one long run
  // -> only its LOWER bound is meaningful. RAIN/SNOW always transition back to
  // clear, so each is exactly one instance and BOTH bounds apply.
  const bad = r.state === 'clear' ? r.len < lo : r.len < lo || r.len > hi;
  if (bad) {
    allInRange = false;
    offender = `${r.state} len=${r.len} not in [${lo},${hi}]`;
    break;
  }
}
ok(completed.length > 0, `observed ${completed.length} completed runs`);
ok(allInRange, `all completed run-lengths in range${offender ? ' — ' + offender : ''}`);

// ===========================================================================
// 4. COLD FLAG — true in rain/snow, false in clear
// ===========================================================================
label('4 isAmbientColdNow() true in rain/snow, false in clear');
let coldConsistent = true;
for (const s of a) {
  const expect = s.state !== 'clear';
  if (s.cold !== expect) coldConsistent = false;
}
ok(coldConsistent, 'cold flag matches (rain/snow => true, clear => false)');

// ===========================================================================
// 5. BOTH BRANCHES — rain AND snow both occur within N
// ===========================================================================
label('5 both rain and snow occur within N ticks');
ok(seen.clear > 0, `clear occurred (${seen.clear} ticks)`);
ok(seen.rain > 0, `rain occurred (${seen.rain} ticks)`);
ok(seen.snow > 0, `snow occurred (${seen.snow} ticks)`);

// ===========================================================================
// 6. EARLY-GAME GATE (v0.8 round 2) — no SNOW before WEATHER_SNOW_EARLIEST_TICK
//    (an early snow roll is redirected to mild rain), but snow DOES arrive after.
// ===========================================================================
label('6 snow gated out of the early game');
let earlySnow = -1;
let lateSnow = -1;
for (let t = 0; t < a.length; t++) {
  if (a[t].state === 'snow') {
    if (t < WEATHER_SNOW_EARLIEST_TICK && earlySnow < 0) earlySnow = t;
    if (t >= WEATHER_SNOW_EARLIEST_TICK && lateSnow < 0) lateSnow = t;
  }
}
ok(earlySnow === -1, `no snow before tick ${WEATHER_SNOW_EARLIEST_TICK} (first early-snow tick=${earlySnow})`);
ok(lateSnow >= 0, `snow still arrives after the grace period (first at tick ${lateSnow})`);

// ---------------------------------------------------------------------------
console.log(`\n${totalFailed === 0 ? 'OVERALL: PASS' : `OVERALL: FAIL (${totalFailed})`}`);
process.exit(totalFailed === 0 ? 0 : 1);
