declare const require: any;
declare const process: any;
/**
 * p10-zoom.test.ts — unit tests for task 10-3 (camera zoom core).
 *   1. Round-trip: screenToWorld(worldToScreen(cell)) ≈ cell for zoom
 *      ∈ {0.5, 1, 2, 3}, at camera origin and scrolled.
 *   2. Zoom-about-anchor: the world cell under a screen anchor stays under
 *      that anchor after setZoom (in and out).
 *   3. clampCamera keeps the camera inside world bounds at ZOOM_MIN/MAX.
 */

// Minimal stubs so camera.ts + config.ts import cleanly.
const g: any = globalThis;
g.performance = g.performance || { now: () => Date.now() };
g.window = g.window || g;

const {
  camera,
  effectiveCellPx,
  screenToWorld,
  worldToScreen,
  clampCamera,
  setZoom,
} = require('../src/camera');
const {
  CELL_SIZE,
  WORLD_W,
  WORLD_H,
  ZOOM_MIN,
  ZOOM_MAX,
} = require('../src/config');

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

function assertClose(a: number, b: number, tol: number, msg: string): void {
  assert(Math.abs(a - b) <= tol, `${msg} (got ${a}, expected ≈${b}, tol ${tol})`);
}

const VP_W = 1280;
const VP_H = 720;

// --- 1. Round-trip at several zooms, at origin and scrolled -----------------
console.log('\n[1] screenToWorld(worldToScreen(cell)) round-trip');
const zooms = [0.5, 1, 2, 3];
const cells = [
  { x: 0, y: 0 },
  { x: 10, y: 5 },
  { x: 137, y: 88 },
  { x: 300, y: 120 },
];
const cameraPositions = [
  { x: 0, y: 0 },
  { x: 50, y: 20 },
];
for (const z of zooms) {
  camera.zoom = z;
  console.log(`  zoom=${z} effCell=${effectiveCellPx()}px`);
  for (const cam of cameraPositions) {
    camera.x = cam.x;
    camera.y = cam.y;
    for (const c of cells) {
      const s = worldToScreen(c.x, c.y);
      const back = screenToWorld(s.x, s.y);
      assertClose(back.x, c.x, 1, `cell.x rt zoom=${z} cam=(${cam.x},${cam.y}) cell=(${c.x},${c.y})`);
      assertClose(back.y, c.y, 1, `cell.y rt zoom=${z} cam=(${cam.x},${cam.y}) cell=(${c.x},${c.y})`);
    }
  }
}

// --- 2. Zoom about a screen anchor ------------------------------------------
console.log('\n[2] setZoom keeps the world cell under the anchor fixed');
// The anchor invariant holds EXCEPT where a world-bound clamp robs the camera
// of freedom on an axis (e.g. at low zoom the world barely exceeds the viewport
// so the camera is pinned). We therefore only assert an axis when that axis is
// NOT sitting on a clamp boundary after the zoom (so the test reflects the real
// guarantee without flagging a legitimate clamp).
function axisFree(camPos: number, maxPos: number): boolean {
  return camPos > 1e-6 && camPos < maxPos - 1e-6;
}
function anchorTest(fromZoom: number, toZoom: number, ax: number, ay: number): void {
  // Start at a scrolled position so it is a genuine test, not the origin.
  camera.zoom = fromZoom;
  camera.x = 120;
  camera.y = 40;
  clampCamera(VP_W, VP_H);

  const before = screenToWorld(ax, ay); // world cell under the anchor now
  setZoom(toZoom, ax, ay, VP_W, VP_H);
  const after = screenToWorld(ax, ay); // world cell under the same anchor now

  const eff = effectiveCellPx();
  const maxX = Math.max(0, (WORLD_W * eff - VP_W) / eff);
  const maxY = Math.max(0, (WORLD_H * eff - VP_H) / eff);

  console.log(
    `  ${fromZoom}->${toZoom} anchor(${ax},${ay}): before=(${before.x.toFixed(2)},${before.y.toFixed(2)}) after=(${after.x.toFixed(2)},${after.y.toFixed(2)}) zoom=${camera.zoom}`,
  );
  if (axisFree(camera.x, maxX)) {
    assertClose(after.x, before.x, 1, `anchor world.x stable ${fromZoom}->${toZoom}`);
  } else {
    console.log(`    (x clamped — anchor invariant waived on x)`);
  }
  if (axisFree(camera.y, maxY)) {
    assertClose(after.y, before.y, 1, `anchor world.y stable ${fromZoom}->${toZoom}`);
  } else {
    console.log(`    (y clamped — anchor invariant waived on y)`);
  }
  assert(camera.zoom === toZoom, `zoom set to ${toZoom}`);
}
anchorTest(1, 2, 640, 360); // zoom in, centre anchor
anchorTest(1, 2, 900, 200); // zoom in, off-centre anchor
anchorTest(2, 1, 640, 360); // zoom out, centre anchor (x & y both have room)
anchorTest(2, 1, 300, 200); // zoom out, off-centre anchor
anchorTest(1, 0.5, 300, 500); // zoom out below 1 (y pins to bounds — x still holds)
// Clamping of the zoom value itself.
camera.x = 0; camera.y = 0; camera.zoom = 1;
setZoom(99, 640, 360, VP_W, VP_H);
assert(camera.zoom === ZOOM_MAX, `setZoom clamps above max -> ${ZOOM_MAX}`);
setZoom(-5, 640, 360, VP_W, VP_H);
assert(camera.zoom === ZOOM_MIN, `setZoom clamps below min -> ${ZOOM_MIN}`);

// --- 3. clampCamera keeps camera in world bounds at zoom extremes -----------
console.log('\n[3] clampCamera bounds at ZOOM_MIN and ZOOM_MAX');
function clampTest(z: number): void {
  camera.zoom = z;
  const eff = effectiveCellPx();
  const maxX = Math.max(0, (WORLD_W * eff - VP_W) / eff);
  const maxY = Math.max(0, (WORLD_H * eff - VP_H) / eff);

  // Push well past the right/bottom edge.
  camera.x = WORLD_W + 9999;
  camera.y = WORLD_H + 9999;
  clampCamera(VP_W, VP_H);
  console.log(`  zoom=${z} eff=${eff} clamped max -> cam=(${camera.x.toFixed(2)},${camera.y.toFixed(2)}) maxX=${maxX.toFixed(2)} maxY=${maxY.toFixed(2)}`);
  assert(camera.x <= maxX + 1e-6 && camera.x >= 0, `x within [0,maxX] at zoom=${z}`);
  assert(camera.y <= maxY + 1e-6 && camera.y >= 0, `y within [0,maxY] at zoom=${z}`);
  // Verify the visible window never extends past the world edge.
  assert(camera.x + VP_W / eff <= WORLD_W + 1e-6, `right edge in-world at zoom=${z}`);
  assert(camera.y + VP_H / eff <= WORLD_H + 1e-6, `bottom edge in-world at zoom=${z}`);

  // Push past the left/top edge.
  camera.x = -9999;
  camera.y = -9999;
  clampCamera(VP_W, VP_H);
  assert(camera.x === 0 && camera.y === 0, `negative clamps to 0 at zoom=${z}`);
}
clampTest(ZOOM_MIN);
clampTest(ZOOM_MAX);
clampTest(1);

// --- summary ----------------------------------------------------------------
console.log(`\np10-zoom: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('FAIL');
  process.exit(1);
}
console.log('PASS');
