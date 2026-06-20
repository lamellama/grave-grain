declare const require: any;
declare const process: any;
/**
 * p10-select.test.ts — headless unit tests for task 10-6 tap-cycle selection.
 * Tests the exported `pickCycling()` pure function from src/input.ts.
 *
 * Verifies:
 *   - cycling through overlapping survivors on repeated same-spot taps (wraps)
 *   - sameSpot=false always returns the nearest
 *   - survivor outside radius is never returned
 *   - dead survivors are skipped
 *   - cycle wraps from last back to first
 */

// ---------------------------------------------------------------------------
// Minimal DOM stubs so the input.ts import chain loads headlessly.
// Pattern follows main-smoke.test.ts / p10-gesture.test.ts.
// ---------------------------------------------------------------------------
function fakeCtx(): any {
  return {
    fillStyle: '#000', font: '', textAlign: 'left',
    save(){}, restore(){}, scale(){},
    fillRect(){}, fillText(){},
    createImageData(w: number, h: number) {
      return { data: new Uint8ClampedArray(Math.max(1, w * h * 4)), width: w, height: h };
    },
    putImageData(){},
    measureText(){ return { width: 0 }; },
  };
}
function fakeEl(): any {
  return {
    width: 0, height: 0, style: {}, dataset: {},
    getContext(){ return fakeCtx(); },
    getBoundingClientRect(){ return { width: 1280, height: 720, left: 0, top: 0, right: 1280, bottom: 720 }; },
    addEventListener(){}, removeEventListener(){},
    setAttribute(){}, getAttribute(){ return null; },
    classList: { add(){}, remove(){}, toggle(){} },
    appendChild(){}, querySelector(){ return null; },
    textContent: '',
  };
}

const g: any = globalThis;
g.devicePixelRatio = 2;
g.requestAnimationFrame = (_fn: Function) => { return 1; };
g.cancelAnimationFrame = () => {};
g.performance = g.performance || { now: () => Date.now() };
g.window = g;
g.document = {
  getElementById(){ return fakeEl(); },
  querySelector(){ return fakeEl(); },
  querySelectorAll(){ return [] as any; },
  createElement(){ return fakeEl(); },
  addEventListener(){}, removeEventListener(){},
  body: fakeEl(),
};
g.addEventListener = () => {};

// ---------------------------------------------------------------------------
// Load modules under test.
// ---------------------------------------------------------------------------
const { pickCycling } = require('../src/input');
const { SELECT_TAP_RADIUS } = require('../src/config');

// ---------------------------------------------------------------------------
// Minimal Survivor stub: only the fields pickCycling reads.
// ---------------------------------------------------------------------------
function makeSurvivor(x: number, y: number, alive = true): any {
  return { body: { x, y, alive } };
}

// ---------------------------------------------------------------------------
// Test runner helpers.
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
// Test data: 3 survivors in a tight clump at ~(50, 50), sorted by distance
// so the deterministic order is A (nearest), B (middle), C (furthest within radius).
// ---------------------------------------------------------------------------
const WX = 50;
const WY = 50;

// A is exactly at the tap point (d=0).
const sA = makeSurvivor(WX, WY);
// B is 2 cells away (d=2).
const sB = makeSurvivor(WX + 2, WY);
// C is 4 cells away (d=4), still within SELECT_TAP_RADIUS (6).
const sC = makeSurvivor(WX + 4, WY);
// D is outside SELECT_TAP_RADIUS — should never be returned.
const sD = makeSurvivor(WX + SELECT_TAP_RADIUS + 2, WY);
// E is dead — should always be skipped.
const sE = makeSurvivor(WX + 1, WY, false);

const clump = [sA, sB, sC, sD, sE];

console.log(`\n[p10-select] pickCycling tests  (SELECT_TAP_RADIUS=${SELECT_TAP_RADIUS})`);

// ---- 1. sameSpot=false → always returns the NEAREST alive within radius ----
console.log('\n-- sameSpot=false (nearest, no cycle) --');

const r1 = pickCycling(clump, WX, WY, SELECT_TAP_RADIUS, null, false);
assert(r1 === sA, `no lastPicked, sameSpot=false → nearest (A)`);

const r2 = pickCycling(clump, WX, WY, SELECT_TAP_RADIUS, sB, false);
assert(r2 === sA, `lastPicked=B but sameSpot=false → nearest (A), not cycle`);

// ---- 2. sameSpot=true → cycles through clump in order A→B→C→A ----
console.log('\n-- sameSpot=true cycling --');

// Start cycle from A → next is B
const c1 = pickCycling(clump, WX, WY, SELECT_TAP_RADIUS, sA, true);
assert(c1 === sB, `cycle: after A → B  (got ${c1 === sA ? 'A' : c1 === sB ? 'B' : c1 === sC ? 'C' : 'other'})`);

// After B → next is C
const c2 = pickCycling(clump, WX, WY, SELECT_TAP_RADIUS, sB, true);
assert(c2 === sC, `cycle: after B → C  (got ${c2 === sA ? 'A' : c2 === sB ? 'B' : c2 === sC ? 'C' : 'other'})`);

// After C → wraps to A (C is last in the candidate list)
const c3 = pickCycling(clump, WX, WY, SELECT_TAP_RADIUS, sC, true);
assert(c3 === sA, `cycle: after C → wraps to A  (got ${c3 === sA ? 'A' : c3 === sB ? 'B' : c3 === sC ? 'C' : 'other'})`);

// Report cycle order for the brief
console.log(`  Cycle order: A→B→C→A (sorted by distance, then list index)`);

// ---- 3. Survivor outside radius is never returned ----
console.log('\n-- Outside-radius guard --');

const r3 = pickCycling([sD], WX, WY, SELECT_TAP_RADIUS, null, false);
assert(r3 === null, `survivor at distance ${SELECT_TAP_RADIUS + 2} outside radius → null`);

// Even when it's the only candidate and sameSpot=true
const r4 = pickCycling([sD], WX, WY, SELECT_TAP_RADIUS, null, true);
assert(r4 === null, `single survivor outside radius, sameSpot=true → null`);

// ---- 4. Dead survivors are skipped ----
console.log('\n-- Dead survivors skipped --');

const r5 = pickCycling([sE], WX, WY, SELECT_TAP_RADIUS, null, false);
assert(r5 === null, `only dead survivor in range → null`);

// Dead survivor does not appear in cycling
const withDead = [sE, sA];
const d1 = pickCycling(withDead, WX, WY, SELECT_TAP_RADIUS, sA, true);
// candidates = [sA] (sE filtered out), idx=0, next=(0+1)%1=0 → sA
assert(d1 === sA, `cycle with dead survivor: skips dead, wraps to only alive (A)`);

// ---- 5. sameSpot=true but lastPicked not in candidate set → falls back to nearest ----
console.log('\n-- lastPicked not in candidate set → reset to nearest --');

const r6 = pickCycling([sA, sB], WX, WY, SELECT_TAP_RADIUS, sC, true);
// sC is not in [sA, sB], so idx=-1 → fall back to nearest = sA
assert(r6 === sA, `sameSpot=true, lastPicked not in set → nearest (A)`);

// ---- 6. Empty list ----
console.log('\n-- Edge cases --');
const r7 = pickCycling([], WX, WY, SELECT_TAP_RADIUS, null, false);
assert(r7 === null, `empty list → null`);

const r8 = pickCycling([], WX, WY, SELECT_TAP_RADIUS, null, true);
assert(r8 === null, `empty list, sameSpot=true → null`);

// ---------------------------------------------------------------------------
// Summary.
// ---------------------------------------------------------------------------
console.log(`\np10-select: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('FAIL');
  process.exit(1);
}
console.log('PASS');
