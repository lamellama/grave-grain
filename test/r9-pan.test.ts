/**
 * r9-pan.test.ts — headless unit tests for the R9 mobile-pan playtest fixes.
 *
 *  1. pinchPanCamera(): the pure two-finger camera solve — the camera position
 *     that pins a world point under a screen midpoint. Dragging both fingers
 *     (midpoint moves, distance constant) must PAN the camera 1:1; spreading
 *     them (zoom changes) must keep the pinned world point under the midpoint.
 *  2. minimapXToWorld round-trip sanity for the scrub path (drag positions map
 *     monotonically across the strip).
 *
 * Runs under CommonJS (tsconfig.r9-pan.json) with minimal stubs.
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
import { pinchPanCamera, pinchZoom } from '../src/input';
import { minimapXToWorld } from '../src/game/ui';
import { CELL_SIZE, WORLD_W } from '../src/config';

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
function assertApprox(label: string, actual: number, expected: number, eps = 1e-9): void {
  assert(`${label} (got ${actual}, expected ${expected})`, Math.abs(actual - expected) < eps);
}

// ---------------------------------------------------------------------------
// 1. pinchPanCamera — pure two-finger solve
// ---------------------------------------------------------------------------
console.log('\n--- pinchPanCamera: two-finger pan (constant zoom) ---');

// Baseline: zoom 1 (eff = CELL_SIZE). World point (100, 50) under midpoint
// (300, 120) → camera = world - mid/eff.
{
  const eff = CELL_SIZE * 1;
  const cam0 = pinchPanCamera(100, 50, 300, 120, eff);
  assertApprox('cam0.x', cam0.x, 100 - 300 / eff);
  assertApprox('cam0.y', cam0.y, 50 - 120 / eff);

  // Drag both fingers 60px right, 30px down (midpoint moves the same): the
  // camera must move LEFT/UP by exactly that many pixels' worth of cells (the
  // world follows the fingers = 1:1 pan).
  const cam1 = pinchPanCamera(100, 50, 360, 150, eff);
  assertApprox('60px midpoint drag pans camera.x by -60/eff', cam0.x - cam1.x, 60 / eff);
  assertApprox('30px midpoint drag pans camera.y by -30/eff', cam0.y - cam1.y, 30 / eff);
}

console.log('\n--- pinchPanCamera: zoom keeps the world point pinned ---');

// Spreading the fingers (zoom 1 → 2) about a stationary midpoint: the pinned
// world point must map back to the midpoint under the NEW effective cell size.
{
  const zoom = pinchZoom(100, 200, 1); // = 2
  const eff = CELL_SIZE * zoom;
  const cam = pinchPanCamera(100, 50, 300, 120, eff);
  // screen position of world (100,50) with this camera = (world - cam) * eff
  assertApprox('pinned world x maps back to midpoint x', (100 - cam.x) * eff, 300);
  assertApprox('pinned world y maps back to midpoint y', (50 - cam.y) * eff, 120);
}

// ---------------------------------------------------------------------------
// 2. minimap scrub mapping — monotone drag across the strip
// ---------------------------------------------------------------------------
console.log('\n--- minimap scrub: drag maps monotonically across the world ---');

{
  const stripW = 800;
  const xs = [0, 100, 200, 400, 600, 799];
  const worlds = xs.map((x) => minimapXToWorld(x, stripW));
  let monotone = true;
  for (let i = 1; i < worlds.length; i++) {
    if (worlds[i] < worlds[i - 1]) monotone = false;
  }
  assert('scrub positions map monotonically', monotone);
  assert('strip left edge → world column 0', worlds[0] === 0);
  assert(`strip right edge → ~WORLD_W (${worlds[worlds.length - 1]})`,
    Math.abs(worlds[worlds.length - 1] - WORLD_W) <= 2);
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\nResults: ${passed} passed, ${failed} failed`);
console.log(failed === 0 ? 'PASS: r9-pan all assertions passed' : 'FAIL: some assertions failed');
if (failed > 0) process.exit(1);
