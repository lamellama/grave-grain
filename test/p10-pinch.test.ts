/**
 * p10-pinch.test.ts — headless unit tests for task 10-5 pinch-zoom.
 * Tests the exported pure helper pinchZoom() and its composition with
 * camera.setZoom (clamped to [ZOOM_MIN, ZOOM_MAX]).
 *
 * Runs under CommonJS (tsconfig.p10-pinch.json) with minimal stubs.
 * No DOM required — pinchZoom is a pure function.
 */
declare const process: any;

// ---------------------------------------------------------------------------
// Minimal stubs so src/input.ts can be imported in a non-DOM environment.
// ---------------------------------------------------------------------------
const g: any = globalThis;
g.performance = g.performance || { now: () => Date.now() };
g.window = g;
g.document = {
  getElementById() { return null; },
  querySelector() { return null; },
  querySelectorAll() { return [] as any; },
  createElement() { return { style: {}, classList: { add(){}, remove(){}, toggle(){} }, addEventListener(){} }; },
  addEventListener() {},
  removeEventListener() {},
  body: { style: {} },
};
g.addEventListener = () => {};

// ---------------------------------------------------------------------------
// Import the modules under test.
// ---------------------------------------------------------------------------
import { pinchZoom } from '../src/input';
import { camera, setZoom } from '../src/camera';
import { ZOOM_MIN, ZOOM_MAX } from '../src/config';

// ---------------------------------------------------------------------------
// Simple assertion helper
// ---------------------------------------------------------------------------
let passed = 0;
let failed = 0;
function assert(label: string, condition: boolean): void {
  if (condition) {
    console.log(`  PASS: ${label}`);
    passed++;
  } else {
    console.error(`  FAIL: ${label}`);
    failed++;
  }
}
function assertApprox(label: string, actual: number, expected: number, eps = 1e-10): void {
  assert(`${label} (got ${actual}, expected ${expected})`, Math.abs(actual - expected) < eps);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
console.log('\n--- pinchZoom pure function ---');

// Basic ratio scaling
assertApprox('pinchZoom(100, 200, 1) === 2', pinchZoom(100, 200, 1), 2);
assertApprox('pinchZoom(200, 100, 2) === 1', pinchZoom(200, 100, 2), 1);
assertApprox('pinchZoom(100, 150, 1) === 1.5', pinchZoom(100, 150, 1), 1.5);
assertApprox('pinchZoom(50, 100, 0.5) === 1.0', pinchZoom(50, 100, 0.5), 1.0);

// startDist = 0 guard: must not return NaN or Infinity, must return startZoom
const guardResult = pinchZoom(0, 100, 1);
assert('pinchZoom(0, 100, 1) is not NaN', !isNaN(guardResult));
assert('pinchZoom(0, 100, 1) is not Infinity', isFinite(guardResult));
assert('pinchZoom(0, 100, 1) returns startZoom (1)', guardResult === 1);

const guardResult2 = pinchZoom(0, 0, 2.5);
assert('pinchZoom(0, 0, 2.5) returns startZoom (2.5)', guardResult2 === 2.5);

console.log('\n--- pinchZoom composed with setZoom clamps to [ZOOM_MIN, ZOOM_MAX] ---');

// A huge ratio should clamp to ZOOM_MAX
{
  camera.zoom = 1;
  const rawZoom = pinchZoom(10, 10000, 1); // startZoom * 1000 = 1000 → clamp to ZOOM_MAX
  // setZoom with a giant anchor — vp size doesn't matter for the clamp test
  setZoom(rawZoom, 0, 0, 1280, 720);
  assert(
    `huge pinch ratio clamps to ZOOM_MAX (${ZOOM_MAX}): got ${camera.zoom}`,
    camera.zoom === ZOOM_MAX,
  );
}

// A tiny ratio should clamp to ZOOM_MIN
{
  camera.zoom = 1;
  const rawZoom = pinchZoom(10000, 1, 1); // startZoom * (1/10000) → clamp to ZOOM_MIN
  setZoom(rawZoom, 0, 0, 1280, 720);
  assert(
    `tiny pinch ratio clamps to ZOOM_MIN (${ZOOM_MIN}): got ${camera.zoom}`,
    camera.zoom === ZOOM_MIN,
  );
}

// Normal ratio stays within range
{
  camera.zoom = 1;
  const rawZoom = pinchZoom(100, 150, 1); // 1.5
  setZoom(rawZoom, 0, 0, 1280, 720);
  assert(
    `normal ratio stays in bounds: ${camera.zoom} in [${ZOOM_MIN}, ${ZOOM_MAX}]`,
    camera.zoom >= ZOOM_MIN && camera.zoom <= ZOOM_MAX,
  );
  assertApprox('normal ratio 1.5 applied correctly', camera.zoom, 1.5);
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\nResults: ${passed} passed, ${failed} failed`);
console.log(failed === 0 ? 'PASS: p10-pinch all assertions passed' : 'FAIL: some assertions failed');
if (failed > 0) process.exit(1);
