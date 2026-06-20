declare const require: any;
declare const process: any;
/**
 * p10-gesture.test.ts — unit tests for task 10-4 gesture classifier.
 * Tests the exported `classifyGesture()` pure function from src/input.ts.
 *
 * Verifies:
 *   - tap   for small move + short hold
 *   - drag  for move exceeding TAP_MAX_MOVE_PX (horizontal and vertical)
 *   - longpress for small move + long hold
 *   - boundary: exactly TAP_MAX_MOVE_PX move → NOT drag (tap/longpress per time)
 *   - boundary: exactly LONG_PRESS_MS held & still → longpress
 */

// ---------------------------------------------------------------------------
// Minimal DOM stubs so input.ts's full import chain loads cleanly headlessly.
// Pattern follows main-smoke.test.ts.
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
// Load the modules under test.
// ---------------------------------------------------------------------------
const { classifyGesture } = require('../src/input');
const { LONG_PRESS_MS, TAP_MAX_MOVE_PX } = require('../src/config');

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
// Tests.
// ---------------------------------------------------------------------------
console.log(`\n[p10-gesture] classifyGesture tests`);
console.log(`  Constants: TAP_MAX_MOVE_PX=${TAP_MAX_MOVE_PX}, LONG_PRESS_MS=${LONG_PRESS_MS}`);

// 1. tap — small move, short hold
const r1 = classifyGesture(2, 2, 100);
assert(r1 === 'tap', `tap (dx=2, dy=2, heldMs=100) → got '${r1}'`);

// 2. drag — horizontal movement exceeds threshold
const r2 = classifyGesture(20, 0, 100);
assert(r2 === 'drag', `drag (dx=20, dy=0, heldMs=100) → got '${r2}'`);

// 3. drag — vertical movement exceeds threshold, long hold (still drag)
const r3 = classifyGesture(0, 15, 1000);
assert(r3 === 'drag', `drag (dx=0, dy=15, heldMs=1000) → got '${r3}'`);

// 4. longpress — small move, held ≥ LONG_PRESS_MS
const r4 = classifyGesture(3, 3, 500);
assert(r4 === 'longpress', `longpress (dx=3, dy=3, heldMs=500) → got '${r4}'`);

// 5. Boundary: exactly TAP_MAX_MOVE_PX distance → NOT drag
//    Math.hypot(TAP_MAX_MOVE_PX, 0) === TAP_MAX_MOVE_PX, which is NOT > TAP_MAX_MOVE_PX
const r5 = classifyGesture(TAP_MAX_MOVE_PX, 0, 100);
assert(
  r5 !== 'drag',
  `at exactly TAP_MAX_MOVE_PX (${TAP_MAX_MOVE_PX}px) move is NOT drag → got '${r5}'`
);

// 6. Boundary: exactly LONG_PRESS_MS held, no movement → longpress
const r6 = classifyGesture(0, 0, LONG_PRESS_MS);
assert(
  r6 === 'longpress',
  `exactly LONG_PRESS_MS (${LONG_PRESS_MS}ms) held still → longpress (got '${r6}')`
);

// ---------------------------------------------------------------------------
// Summary.
// ---------------------------------------------------------------------------
console.log(`\np10-gesture: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('FAIL');
  process.exit(1);
}
console.log('PASS');
