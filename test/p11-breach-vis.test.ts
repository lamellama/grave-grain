declare const require: any;
declare const process: any;
/**
 * p11-breach-vis.test.ts — Headless tests for task 11-4 breach visualisation.
 *
 * Tests:
 *   1. breachDarken — pure colour-darkening helper
 *      a) Full integrity → colour unchanged
 *      b) Monotonically darker at 200, 100, 1 (WALL)
 *      c) Max darkening near integrity 1 (≈ ×(1-BREACH_DARKEN_MAX))
 *      d) baseIntegrity 0 → colour unchanged (non-integrity material)
 *   2. Chip-flash registry
 *      a) Recording a chip then advancing > CHIP_FLASH_TICKS expires it
 *   3. directionToWorldX — off-screen breach direction
 *      a) Column left of camera → '←'
 *      b) Column right of camera → '→'
 *      c) Column on-screen → ''
 */

// ---------------------------------------------------------------------------
// Minimal stubs so camera.ts initialises without DOM access
// ---------------------------------------------------------------------------
const g: any = globalThis;
g.performance = g.performance || { now: () => Date.now() };

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------
let passed = 0;
let failed = 0;

function assert(cond: boolean, msg: string): void {
  if (cond) {
    console.log('  PASS:', msg);
    passed++;
  } else {
    console.error('  FAIL:', msg);
    failed++;
  }
}

// ---------------------------------------------------------------------------
// 1. breachDarken — pure helper exported from renderer.ts
// ---------------------------------------------------------------------------
console.log('\n--- breachDarken ---');

const renderer = require('../src/render/renderer');
const breachDarken: (
  rgb: [number, number, number],
  integrity: number,
  baseIntegrity: number,
) => [number, number, number] = renderer.breachDarken;

const config = require('../src/config');
const BREACH_DARKEN_MAX: number = config.BREACH_DARKEN_MAX;
const CHIP_FLASH_TICKS: number = config.CHIP_FLASH_TICKS;
const WALL_INTEGRITY: number = config.WALL_INTEGRITY; // 200

// Use a neutral mid-grey so channel values are easy to reason about.
const BASE_RGB: [number, number, number] = [180, 180, 180];

// 1a — Full integrity: colour unchanged
const fullResult = breachDarken(BASE_RGB, WALL_INTEGRITY, WALL_INTEGRITY);
assert(
  fullResult[0] === BASE_RGB[0] &&
  fullResult[1] === BASE_RGB[1] &&
  fullResult[2] === BASE_RGB[2],
  'full integrity returns identical RGB (no darkening)',
);

// 1b — Monotonically darker as integrity falls (200 > 100 > 1)
const at200 = breachDarken(BASE_RGB, 200, WALL_INTEGRITY)[0]; // full
const at100 = breachDarken(BASE_RGB, 100, WALL_INTEGRITY)[0];
const at1   = breachDarken(BASE_RGB, 1,   WALL_INTEGRITY)[0];
assert(at200 >= at100, 'integrity 200 not darker than 100');
assert(at100 >= at1,   'integrity 100 not darker than 1');
assert(at200 > at1,    'wall at full integrity is brighter than near-zero');
console.log('  (R channel at 200/100/1 integrity:', at200, at100, at1, ')');

// 1c — Max darkening near integrity 1: factor ≈ 1 - BREACH_DARKEN_MAX
const expectedFactor = 1 - BREACH_DARKEN_MAX; // 0.4 for BREACH_DARKEN_MAX=0.6
const nearZeroResult = breachDarken(BASE_RGB, 1, WALL_INTEGRITY);
const expectedR = Math.round(BASE_RGB[0] * expectedFactor); // ≈72 for BASE_RGB=180
// Allow ±2 for integer rounding
assert(
  Math.abs(nearZeroResult[0] - expectedR) <= 2,
  `near-zero integrity R≈${expectedR} (got ${nearZeroResult[0]}, factor=${expectedFactor})`,
);

// 1d — baseIntegrity 0 → unchanged (non-integrity material guard)
const noInteg = breachDarken([200, 150, 100], 0, 0);
assert(
  noInteg[0] === 200 && noInteg[1] === 150 && noInteg[2] === 100,
  'baseIntegrity 0 leaves colour unchanged',
);

// ---------------------------------------------------------------------------
// 2. Chip-flash registry
// ---------------------------------------------------------------------------
console.log('\n--- chip-flash registry ---');

const breachingMod = require('../src/game/breaching');
const recentChips: Map<number, number> = breachingMod.recentChips;
const getBreachTick: () => number = breachingMod.getBreachTick;
const resolveBreaching: (zombies: any[]) => void = breachingMod.resolveBreaching;

// Flush any leftover state from module init
recentChips.clear();

// Record a chip at the CURRENT breach tick
const testKey = 999; // arbitrary cell index
const chipTick = getBreachTick();
recentChips.set(testKey, chipTick);
assert(recentChips.has(testKey), 'chip entry exists immediately after recording');

// Advance CHIP_FLASH_TICKS + 1 times via empty resolveBreaching calls
// (each call increments _breachTick and prunes expired entries)
for (let i = 0; i < CHIP_FLASH_TICKS + 1; i++) {
  resolveBreaching([]); // no zombies → no new chips, just ticks + prunes
}

assert(
  !recentChips.has(testKey),
  `chip entry is pruned after ${CHIP_FLASH_TICKS + 1} advance ticks (> CHIP_FLASH_TICKS=${CHIP_FLASH_TICKS})`,
);

// Verify that a chip recorded NOW is still present (not yet expired)
const freshKey = 1234;
const freshChipTick = getBreachTick();
recentChips.set(freshKey, freshChipTick);
// One advance — age=1 < CHIP_FLASH_TICKS
resolveBreaching([]);
assert(
  recentChips.has(freshKey),
  'chip recorded now is still present after 1 advance (age < CHIP_FLASH_TICKS)',
);

// ---------------------------------------------------------------------------
// 3. directionToWorldX — off-screen breach direction
// ---------------------------------------------------------------------------
console.log('\n--- directionToWorldX ---');

const ui = require('../src/game/ui');
const directionToWorldX: (
  worldX: number,
  cam: { x: number },
  viewportWpx: number,
) => string = ui.directionToWorldX;

// With camera.x=0 and viewportWpx=600, effectiveCellPx() = CELL_SIZE * zoom = 6*1 = 6.
// visRight = 0 + 600/6 = 100 cells.
const CAM = { x: 0 };
const VPW = 600;

// 3a — Off-screen LEFT (worldX < cam.x)
const dirLeft = directionToWorldX(-10, CAM, VPW);
assert(dirLeft === '\u2190', `worldX=-10 off-screen left → '←' (got '${dirLeft}')`);

// 3b — Off-screen RIGHT (worldX >= cam.x + vpW/cellPx)
const dirRight = directionToWorldX(150, CAM, VPW);
assert(dirRight === '\u2192', `worldX=150 off-screen right → '→' (got '${dirRight}')`);

// 3c — On-screen
const dirOn = directionToWorldX(50, CAM, VPW);
assert(dirOn === '', `worldX=50 on-screen → '' (got '${dirOn}')`);

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('FAIL: p11-breach-vis tests failed');
  process.exit(1);
} else {
  console.log('PASS: p11-breach-vis all tests passed');
}
