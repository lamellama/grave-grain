declare const require: any; declare const process: any;
/**
 * p11-balance.test.ts — Phase 11 task 11-7 headless balance + juice tests.
 *
 * (a) Sanity-check key balance constants are within sane bounds for a
 *     "fair and clearable but tense" run (GDD §7.1, §11).
 * (b) Juice is bounded: registerHit past MAX_HIT_FLASHES doesn't grow the
 *     array unboundedly, and a flash expires after HIT_FLASH_TICKS ticks.
 */

// ── Balance constants ─────────────────────────────────────────────────────
const {
  WIN_WAVES,
  MAX_ZOMBIES,
  STARTING_AMMO,
  HUNGER_RATE,
  THIRST_RATE,
  WAVE_INTERVAL,
  WAVE_INTERVAL_MIN,
  WAVE_SIZE_START,
  WAVE_SIZE_GROWTH,
  HIT_FLASH_TICKS,
  MAX_HIT_FLASHES,
  SCREEN_SHAKE_PX,
} = require('../src/config');

let pass = true;
function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error('FAIL:', msg);
    pass = false;
  } else {
    console.log('  ok:', msg);
  }
}

console.log('\n── Balance constants ────────────────────────────────────────────────');
assert(WIN_WAVES >= 3, `WIN_WAVES (${WIN_WAVES}) >= 3`);
assert(MAX_ZOMBIES >= 8 && MAX_ZOMBIES <= 64, `MAX_ZOMBIES (${MAX_ZOMBIES}) in [8,64]`);
assert(STARTING_AMMO >= 5 && STARTING_AMMO <= 40, `STARTING_AMMO (${STARTING_AMMO}) in [5,40]`);
assert(HUNGER_RATE > 0 && HUNGER_RATE < 0.1, `HUNGER_RATE (${HUNGER_RATE}) > 0 and small`);
assert(THIRST_RATE > 0 && THIRST_RATE < 0.1, `THIRST_RATE (${THIRST_RATE}) > 0 and small`);
assert(WAVE_INTERVAL >= WAVE_INTERVAL_MIN, `WAVE_INTERVAL (${WAVE_INTERVAL}) >= WAVE_INTERVAL_MIN (${WAVE_INTERVAL_MIN})`);
assert(WAVE_INTERVAL_MIN >= 600, `WAVE_INTERVAL_MIN (${WAVE_INTERVAL_MIN}) >= 600 ticks (10 s)`);
assert(WAVE_SIZE_START >= 1, `WAVE_SIZE_START (${WAVE_SIZE_START}) >= 1`);
assert(WAVE_SIZE_GROWTH >= 0, `WAVE_SIZE_GROWTH (${WAVE_SIZE_GROWTH}) >= 0`);

console.log('\n── Juice constants ──────────────────────────────────────────────────');
assert(HIT_FLASH_TICKS === 18, `HIT_FLASH_TICKS === 18 (got ${HIT_FLASH_TICKS})`);
assert(MAX_HIT_FLASHES === 24, `MAX_HIT_FLASHES === 24 (got ${MAX_HIT_FLASHES})`);
assert(SCREEN_SHAKE_PX >= 0 && SCREEN_SHAKE_PX <= 4, `SCREEN_SHAKE_PX (${SCREEN_SHAKE_PX}) in [0,4]`);

// ── Juice bounded behaviour ───────────────────────────────────────────────
console.log('\n── Juice bounded behaviour ──────────────────────────────────────────');

// Stub canvas/DOM globals for the ui module import.
const g: any = globalThis;
g.devicePixelRatio = 1;
g.performance = g.performance || { now: () => Date.now() };
g.window = g;
g.document = {
  getElementById() { return null; },
  querySelector() { return null; },
  querySelectorAll() { return [] as any; },
  createElement() { return null; },
  addEventListener() {},
  removeEventListener() {},
  body: null,
};
g.addEventListener = () => {};
g.cancelAnimationFrame = () => {};
g.requestAnimationFrame = () => 0;

// Import the ui module after DOM stub is set.
const ui = require('../src/game/ui');

// (1) Registering > MAX_HIT_FLASHES hits must NOT grow the array past the cap.
for (let i = 0; i < MAX_HIT_FLASHES + 10; i++) {
  ui.registerHit(i * 5, 100);
}
const countAfterOverflow = ui._hitFlashCount();
assert(
  countAfterOverflow <= MAX_HIT_FLASHES,
  `After ${MAX_HIT_FLASHES + 10} registerHit calls, count (${countAfterOverflow}) <= MAX_HIT_FLASHES (${MAX_HIT_FLASHES})`,
);

// (2) A flash must expire after exactly HIT_FLASH_TICKS ticks of advanceHitFlashes.
// Reset: we know count is MAX_HIT_FLASHES from the overflow test, but let's add
// a fresh batch so the ages are predictable. We cannot easily clear the internal
// array; instead we can advance past all existing entries first.
for (let t = 0; t < HIT_FLASH_TICKS; t++) {
  ui.advanceHitFlashes();
}
const countAfterExpiry = ui._hitFlashCount();
assert(
  countAfterExpiry === 0,
  `After ${HIT_FLASH_TICKS} advanceHitFlashes ticks, all flashes expired (count=${countAfterExpiry})`,
);

// (3) Add a single fresh flash and confirm it expires exactly at tick HIT_FLASH_TICKS.
ui.registerHit(50, 50);
assert(ui._hitFlashCount() === 1, 'Single fresh hit registered (count=1)');
for (let t = 0; t < HIT_FLASH_TICKS - 1; t++) {
  ui.advanceHitFlashes();
}
const countBeforeExpiry = ui._hitFlashCount();
assert(countBeforeExpiry === 1, `Flash still alive at tick ${HIT_FLASH_TICKS - 1} (count=${countBeforeExpiry})`);
ui.advanceHitFlashes(); // the final tick
const countExactExpiry = ui._hitFlashCount();
assert(countExactExpiry === 0, `Flash expired exactly at tick ${HIT_FLASH_TICKS} (count=${countExactExpiry})`);

// ── Summary ───────────────────────────────────────────────────────────────
console.log('');
console.log(pass
  ? 'PASS: all p11-balance checks passed'
  : 'FAIL: one or more p11-balance checks failed');
if (!pass) process.exit(1);
