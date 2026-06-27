/**
 * engine/weather.ts — Deterministic weather state machine + ambient temperature
 * (GDD §10, Beyond T2). Pure, DOM-free engine module.
 *
 * Determinism is the whole point (GDD §13): this will later run inside
 * `simulation.step()`, which carries a chunk byte-equivalence invariant and a
 * seeded-RNG invariant. So weather MUST be a pure function of (tick, seed) —
 * never `Math.random`, never a mutable RNG accumulator whose value could differ
 * between a chunked and an unchunked scan. The state machine holds only its
 * current state + the tick the state ends at; every random DRAW is recomputed
 * from a stateless hash of the input tick, so replaying the same tick sequence
 * from the same reset state always reproduces the identical state+duration
 * stream.
 */

import {
  WEATHER_ENABLED,
  WEATHER_RNG_SEED,
  WEATHER_CLEAR_MIN_TICKS,
  WEATHER_CLEAR_MAX_TICKS,
  WEATHER_RAIN_MIN_TICKS,
  WEATHER_RAIN_MAX_TICKS,
  WEATHER_SNOW_MIN_TICKS,
  WEATHER_SNOW_MAX_TICKS,
  WEATHER_TO_RAIN_CHANCE,
  WEATHER_TO_SNOW_CHANCE,
  TEMP_CLEAR,
  TEMP_RAIN,
  TEMP_SNOW,
  COLD_THRESHOLD,
} from '../config';

export type WeatherState = 'clear' | 'rain' | 'snow';

/**
 * Module-level state, mirroring how resources.ts / the sim tick hold theirs.
 * `state` is the active weather; `stateUntilTick` is the (exclusive) tick at
 * which the current state expires and a transition is evaluated.
 */
let state: WeatherState = 'clear';
let stateUntilTick = 0;

/**
 * Distinct salts so the two draws at one transition tick (which next state?
 * and how long?) use independent hash streams and aren't correlated.
 */
const SALT_TRANSITION = 1; // clear→rain/snow branch roll
const SALT_DURATION = 2; // length of the newly-entered state

/**
 * Pure hash RNG seeded by (tick, WEATHER_RNG_SEED, salt) — a direct mirror of
 * simulation.ts's `simRand` avalanche, minus the x/y cell coords (weather is
 * global, not per-cell). Returns a float in [0, 1).
 *
 *   h = WEATHER_RNG_SEED
 *   h = imul(h ^ tick, 0x85ebca6b); h ^= h>>>13
 *   h = imul(h ^ salt, 0xc2b2ae35); h ^= h>>>16
 *   return (h>>>0) / 2^32
 *
 * Desync-proof because the result depends ONLY on (tick, seed, salt) — never on
 * call order, call count, or any mutable accumulator. Whether weather is stepped
 * inside a chunked or an unchunked scan, the same tick draws the same value.
 */
function weatherRand(tick: number, salt: number): number {
  let h = WEATHER_RNG_SEED >>> 0;
  h = Math.imul(h ^ (tick >>> 0), 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h ^ (salt >>> 0), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Inclusive-range integer duration draw for a state, from a [0,1) roll. */
function durationFor(s: WeatherState, tick: number): number {
  const r = weatherRand(tick, SALT_DURATION);
  let min: number;
  let max: number;
  if (s === 'rain') {
    min = WEATHER_RAIN_MIN_TICKS;
    max = WEATHER_RAIN_MAX_TICKS;
  } else if (s === 'snow') {
    min = WEATHER_SNOW_MIN_TICKS;
    max = WEATHER_SNOW_MAX_TICKS;
  } else {
    min = WEATHER_CLEAR_MIN_TICKS;
    max = WEATHER_CLEAR_MAX_TICKS;
  }
  // [min, max] inclusive.
  return min + Math.floor(r * (max - min + 1));
}

/**
 * Advance the weather state machine for one sim tick. Call once per tick.
 * When the current state has expired (`tick >= stateUntilTick`), transition and
 * pick a fresh duration; otherwise no-op. With WEATHER_ENABLED false, weather is
 * pinned to 'clear' and never transitions.
 */
export function updateWeather(tick: number): void {
  if (!WEATHER_ENABLED) {
    state = 'clear';
    stateUntilTick = Infinity;
    return;
  }
  if (tick < stateUntilTick) return;

  if (state === 'clear') {
    // From clear: roll once. rain | snow | (stay clear). GDD §10.
    const r = weatherRand(tick, SALT_TRANSITION);
    if (r < WEATHER_TO_RAIN_CHANCE) {
      state = 'rain';
    } else if (r < WEATHER_TO_RAIN_CHANCE + WEATHER_TO_SNOW_CHANCE) {
      state = 'snow';
    } else {
      state = 'clear';
    }
  } else {
    // Rain or snow always returns to clear.
    state = 'clear';
  }
  stateUntilTick = tick + durationFor(state, tick);
}

/** Current weather state. */
export function getWeather(): WeatherState {
  return state;
}

/** Ambient temperature (°C, abstract) for the current weather state (GDD §10). */
export function getTemperature(): number {
  if (state === 'rain') return TEMP_RAIN;
  if (state === 'snow') return TEMP_SNOW;
  return TEMP_CLEAR;
}

/**
 * True when ambient conditions count as "cold" for the warmth need (GDD §10).
 * T4 will swap the survivor warmth hook onto this.
 */
export function isAmbientColdNow(): boolean {
  return WEATHER_ENABLED && getTemperature() < COLD_THRESHOLD;
}

/**
 * Reset to clear with a fresh duration drawn from tick 0 (new-game init + test
 * harnesses), mirroring resetQueue/resetStockpile.
 */
export function resetWeather(): void {
  state = 'clear';
  stateUntilTick = WEATHER_ENABLED ? durationFor('clear', 0) : Infinity;
}

/**
 * TEST-ONLY: pin the weather to a fixed state (T3 sim wiring). Sets the state
 * AND parks `stateUntilTick` at Infinity so the next `updateWeather(tick)` is a
 * no-op and the forced state holds for the whole run — exactly what the
 * chunk-equivalence / rain-douse / snow-pile sim tests need to FORCE a rain or
 * snow phase deterministically without driving thousands of ticks. Production
 * code never calls this; the double-underscore marks it test-only.
 */
export function __setWeatherForTest(s: WeatherState): void {
  state = s;
  stateUntilTick = Infinity;
}

// Module-init: start in a long CLEAR period (a fresh duration drawn from tick
// 0), NOT the bare `stateUntilTick = 0` default — otherwise the very first
// `updateWeather(0)` inside `step()` would immediately roll a transition and
// could spawn precipitation at tick 0. With WEATHER_CLEAR_MIN_TICKS in the
// thousands, every pre-existing sim test (p11 equivalence/perf, p2 fire) runs
// its few-hundred ticks entirely within this clear window, so wiring weather
// into step() is a no-op for them. New-game init / tests call resetWeather()
// to re-draw this from a known point.
resetWeather();
