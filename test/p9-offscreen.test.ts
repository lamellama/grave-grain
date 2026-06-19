declare const require: any;
declare const process: any;
/**
 * p9-offscreen.test.ts — unit tests for task 9-6:
 *   - minimapXToWorld / round-trip (worldX → stripX → worldX within tolerance)
 *   - jumpCameraTo centres and clamps (near 0, mid, > WORLD_W)
 *   - directionToWorldX returns correct arrow symbols
 */

// Minimal stubs so camera.ts + config.ts import cleanly.
const g: any = globalThis;
g.performance = g.performance || { now: () => Date.now() };
g.window = g.window || g;

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

// ---------------------------------------------------------------------------
// Import modules under test
// ---------------------------------------------------------------------------
const ui     = require('../src/game/ui');
const camMod = require('../src/camera');
const cfg    = require('../src/config');

const minimapXToWorld: (clientX: number, cw: number) => number = ui.minimapXToWorld;
const directionToWorldX: (worldX: number, cam: any, vw: number) => string = ui.directionToWorldX;
const { jumpCameraTo } = camMod;
const { camera, clampCamera } = camMod;
const { WORLD_W, CELL_SIZE } = cfg;

// ---------------------------------------------------------------------------
// 1. minimapXToWorld round-trip
// ---------------------------------------------------------------------------
console.log('\n--- minimapXToWorld round-trip ---');

// Strip: full WORLD_W cells mapped to canvasWidthCss pixels.
// forward: worldX → stripX = (worldX / WORLD_W) * cw
// inverse: minimapXToWorld(stripX, cw) ≈ worldX
const CANVAS_W = 1280; // representative canvas width in css-px

function worldToStripX(worldX: number, cw: number): number {
  return (worldX / WORLD_W) * cw;
}

const testCols = [0, 100, 320, 640, WORLD_W - 1, WORLD_W];
for (const wx of testCols) {
  const stripX = worldToStripX(wx, CANVAS_W);
  const recovered = minimapXToWorld(stripX, CANVAS_W);
  // Allow ±1 cell tolerance for rounding.
  assertClose(recovered, Math.min(wx, WORLD_W), 1,
    `round-trip worldX=${wx} → stripX=${stripX.toFixed(1)} → worldX`);
}

// Edge: clientX === 0 → world 0; clientX === cw → world WORLD_W.
assert(minimapXToWorld(0, CANVAS_W) === 0, 'clientX=0 → worldX=0');
assert(minimapXToWorld(CANVAS_W, CANVAS_W) === WORLD_W, `clientX=cw → worldX=${WORLD_W}`);

// Guard: canvasWidthCss=0 returns 0 without throwing.
assert(minimapXToWorld(100, 0) === 0, 'guard: canvasWidth=0 returns 0');

// ---------------------------------------------------------------------------
// 2. jumpCameraTo centres and clamps
// ---------------------------------------------------------------------------
console.log('\n--- jumpCameraTo clamp ---');

const VP_W = 1920; // viewport width in px (e.g. full HD)
const VP_H = 1080;
const cellsPerScreen = VP_W / CELL_SIZE;
const maxCameraX = Math.max(0, WORLD_W - cellsPerScreen);

function resetCamera(): void {
  camera.x = 0;
  camera.y = 0;
}

// Mid-world: camera should centre on targetX.
resetCamera();
const midTarget = 640;
jumpCameraTo(midTarget, VP_W, VP_H);
const expectedMid = midTarget - cellsPerScreen / 2;
assertClose(camera.x, Math.max(0, Math.min(expectedMid, maxCameraX)), 0.5,
  `jumpCameraTo mid: camera.x centred on ${midTarget}`);
assert(camera.x >= 0, 'jumpCameraTo mid: camera.x not negative');
assert(camera.x <= maxCameraX + 0.01, 'jumpCameraTo mid: camera.x within maxX');

// Near left edge (x=0): clamps to 0 (never negative).
resetCamera();
jumpCameraTo(0, VP_W, VP_H);
assert(camera.x >= 0, 'jumpCameraTo x=0: camera.x not negative (clamped)');
assert(camera.x <= maxCameraX + 0.01, 'jumpCameraTo x=0: camera.x within maxX');

// Beyond right edge: clamps to maxX.
resetCamera();
jumpCameraTo(WORLD_W + 9999, VP_W, VP_H);
assertClose(camera.x, maxCameraX, 0.01,
  `jumpCameraTo far-right: camera.x clamped to maxX (${maxCameraX})`);
assert(camera.x >= 0, 'jumpCameraTo far-right: camera.x not negative');

// ---------------------------------------------------------------------------
// 3. directionToWorldX
// ---------------------------------------------------------------------------
console.log('\n--- directionToWorldX ---');

const fakeCam = { x: 200 }; // camera at cell 200
const fakeVW = 600; // 600 px viewport → 100 cells visible (CELL_SIZE=6)
// visLeft=200, visRight=300

assert(directionToWorldX(100, fakeCam, fakeVW) === '←', 'worldX=100 → ←');
assert(directionToWorldX(350, fakeCam, fakeVW) === '→', 'worldX=350 → →');
assert(directionToWorldX(250, fakeCam, fakeVW) === '', 'worldX=250 (on-screen) → \'\'');
assert(directionToWorldX(200, fakeCam, fakeVW) === '', 'worldX=200 (left edge) → \'\'');
assert(directionToWorldX(199, fakeCam, fakeVW) === '←', 'worldX=199 (just off-screen left) → ←');
assert(directionToWorldX(300, fakeCam, fakeVW) === '→', 'worldX=300 (right edge, exclusive) → →');

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('FAIL: p9-offscreen tests failed');
  process.exit(1);
} else {
  console.log('PASS: p9-offscreen all tests passed');
}
