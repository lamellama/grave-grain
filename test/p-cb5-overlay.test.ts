declare const require: any;
declare const process: any;
/**
 * p-cb5-overlay.test.ts — CB-5: Blueprint overlay rendering
 * (GDD §8 building feedback, §12 UI).
 *
 * Done-when assertions:
 *   1. Render invariant intact: canvas backing-store == viewportWidthPx/Height
 *      after render (same check as p10-resize invariant).
 *   2. Overlay draws at the right place: fillRect called for an in-viewport
 *      blueprint at the IDENTICAL screen rect a body/cell at (x,y) maps to.
 *   3. Off-screen blueprint: no fillRect issued for a blueprint outside the
 *      viewport (viewport cull works).
 */

// ---------------------------------------------------------------------------
// Minimal stubs — must appear before any require('../src/...') calls so the
// modules see a complete DOM environment.
// ---------------------------------------------------------------------------
const g: any = globalThis;
g.performance = g.performance || { now: () => Date.now() };
g.devicePixelRatio = 1;
g.window = g;

// Track fillRect calls on a spy context.
interface FillRectCall { x: number; y: number; w: number; h: number; style: string; }
let fillRectCalls: FillRectCall[] = [];
let putImageDataCalls = 0;
let lastImageDataW = 0;
let lastImageDataH = 0;

function makeCtx(viewportW: number, viewportH: number): any {
  return {
    fillStyle: '',
    font: '',
    textAlign: 'left',
    save() {},
    restore() {},
    scale() {},
    fillText() {},
    measureText() { return { width: 0 }; },
    createImageData(w: number, h: number) {
      lastImageDataW = w;
      lastImageDataH = h;
      return { data: new Uint8ClampedArray(Math.max(1, w * h * 4)), width: w, height: h };
    },
    putImageData() { putImageDataCalls++; },
    fillRect(x: number, y: number, w: number, h: number) {
      fillRectCalls.push({ x, y, w, h, style: this.fillStyle });
    },
  };
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------
let passed = 0;
let failed = 0;
let totalFailed = 0;

function assert(cond: boolean, msg: string): void {
  if (cond) {
    console.log(`  PASS: ${msg}`);
    passed++;
  } else {
    console.log(`  FAIL: ${msg}`);
    failed++;
    totalFailed++;
  }
}

// ---------------------------------------------------------------------------
// Import modules under test
// ---------------------------------------------------------------------------
const { initRenderer } = require('../src/render/renderer');
const { camera, effectiveCellPx } = require('../src/camera');
const { resetQueue, addBlueprint, getBlueprints } = require('../src/game/buildqueue');
const { CELL_SIZE, BLUEPRINT_FILL_FENCE, BLUEPRINT_FILL_WALL, BLUEPRINT_RESERVED_ALPHA_MULT } = require('../src/config');
// Grid is initialized at module load via typed arrays — no initGrid needed.
const { WORLD_W, WORLD_H } = require('../src/config');

// ---------------------------------------------------------------------------
// Constants for this test
// ---------------------------------------------------------------------------
const VW = 400;
const VH = 300;
const ZOOM = 1; // camera.zoom default is ZOOM_DEFAULT; set explicitly below.

// Place the camera at cell (0,0) so cell coords == simple offsets.
camera.x = 0;
camera.y = 0;
camera.zoom = 1;

// Cell at (10, 20) is within the viewport (400/CELL_SIZE, 300/CELL_SIZE cells).
// effectiveCellPx() = CELL_SIZE * 1 = CELL_SIZE.
const effCell = effectiveCellPx(); // = CELL_SIZE * camera.zoom = CELL_SIZE

// Oracle rect for a cell at (cellX, cellY) — identical floor-of-edges math from renderer.ts.
function oracleRect(cellX: number, cellY: number) {
  const sx0 = Math.floor((cellX - camera.x) * effCell);
  const sy0 = Math.floor((cellY - camera.y) * effCell);
  const sx1 = Math.floor((cellX + 1 - camera.x) * effCell);
  const sy1 = Math.floor((cellY + 1 - camera.y) * effCell);
  return { x: sx0, y: sy0, w: sx1 - sx0, h: sy1 - sy0 };
}

// Build a canvas stub sized to VW×VH.
function makeCanvas(w: number, h: number): any {
  return {
    width: w,
    height: h,
    style: {},
    dataset: {},
    getContext() {
      return makeCtx(w, h);
    },
    getBoundingClientRect() {
      return { width: w, height: h, left: 0, top: 0, right: w, bottom: h };
    },
    addEventListener() {},
  };
}

// ===========================================================================
// [1] Render invariant: ImageData size == viewportWidthPx × viewportHeightPx
// ===========================================================================
console.log('\n=== [1] Render invariant: ImageData == backing-store size ===');
{
  resetQueue();
  fillRectCalls = [];
  putImageDataCalls = 0;

  const canvas = makeCanvas(VW, VH);
  const ctx = makeCtx(VW, VH);
  // Replace canvas.getContext to return our spy ctx.
  canvas.getContext = () => ctx;

  const renderer = initRenderer(canvas, ctx);
  renderer.render();

  assert(
    lastImageDataW === VW && lastImageDataH === VH,
    `ImageData created at ${lastImageDataW}×${lastImageDataH} == viewport ${VW}×${VH}`,
  );
  assert(
    renderer.viewportWidthPx === VW,
    `renderer.viewportWidthPx (${renderer.viewportWidthPx}) == ${VW}`,
  );
  assert(
    renderer.viewportHeightPx === VH,
    `renderer.viewportHeightPx (${renderer.viewportHeightPx}) == ${VH}`,
  );
  assert(putImageDataCalls >= 1, `putImageData called at least once (got ${putImageDataCalls})`);
}

// ===========================================================================
// [2] Overlay: in-viewport blueprint → fillRect at the correct cell screen rect
// ===========================================================================
console.log('\n=== [2] In-viewport blueprint → fillRect at oracle rect ===');
{
  resetQueue();
  fillRectCalls = [];

  // Choose a cell well within the viewport.
  // With CELL_SIZE cells fitting in 400px wide, pick a cell at (2, 3).
  const BPX = 2;
  const BPY = 3;

  // addBlueprint needs a standable cell — the grid is initialized with AIR (0).
  // addBlueprint checks: inBounds, no duplicate, queue cap, NOT already the target material.
  // WOOD is not AIR so it won't be blocked. 'fence' → WOOD material.
  // The cell at (2,3) is AIR; placing a fence blueprint there is valid.
  const placed = addBlueprint(BPX, BPY, 'fence');
  assert(placed, `addBlueprint(${BPX}, ${BPY}, 'fence') returned true`);

  const canvas = makeCanvas(VW, VH);
  const ctx = makeCtx(VW, VH);
  canvas.getContext = () => ctx;

  initRenderer(canvas, ctx);
  const { getRenderer } = require('../src/render/renderer');
  const renderer = getRenderer();

  // Reset call log after initRenderer (which doesn't render).
  fillRectCalls = [];
  renderer.render();

  // Filter to blueprint-overlay calls: those with the fence fill colour.
  // FPS fillText uses fillStyle but not fillRect; body pixels use rgb() not rgba().
  const bpCalls = fillRectCalls.filter(c =>
    typeof c.style === 'string' && c.style.startsWith('rgba(')
  );

  const oracle = oracleRect(BPX, BPY);

  assert(bpCalls.length >= 1, `at least one rgba fillRect call (blueprint overlay) — got ${bpCalls.length}`);

  if (bpCalls.length >= 1) {
    const call = bpCalls[0];
    assert(
      call.x === oracle.x && call.y === oracle.y && call.w === oracle.w && call.h === oracle.h,
      `fillRect(${call.x},${call.y},${call.w},${call.h}) == oracle(${oracle.x},${oracle.y},${oracle.w},${oracle.h})`,
    );
  }

  // Confirm the fillStyle is the fence colour (unreserved).
  if (bpCalls.length >= 1) {
    const bp = getBlueprints()[0];
    const expectedStyle = bp.reserved ? '' /* checked below */ : BLUEPRINT_FILL_FENCE;
    if (!bp.reserved) {
      assert(
        bpCalls[0].style === expectedStyle,
        `fillStyle is BLUEPRINT_FILL_FENCE '${BLUEPRINT_FILL_FENCE}' (got '${bpCalls[0].style}')`,
      );
    }
  }
}

// ===========================================================================
// [2b] Reserved blueprint → boosted alpha in fillStyle
// ===========================================================================
console.log('\n=== [2b] Reserved blueprint → boosted alpha ===');
{
  resetQueue();
  fillRectCalls = [];

  const BPX = 2;
  const BPY = 3;
  addBlueprint(BPX, BPY, 'fence');
  const bps = getBlueprints();
  bps[0].reserved = true;

  const canvas = makeCanvas(VW, VH);
  const ctx = makeCtx(VW, VH);
  canvas.getContext = () => ctx;
  initRenderer(canvas, ctx);
  const { getRenderer } = require('../src/render/renderer');
  fillRectCalls = [];
  getRenderer().render();

  const bpCalls = fillRectCalls.filter(c =>
    typeof c.style === 'string' && c.style.startsWith('rgba(')
  );

  assert(bpCalls.length >= 1, `reserved blueprint produced a fillRect call`);
  if (bpCalls.length >= 1) {
    // Parse alpha from 'rgba(r,g,b,a)'.
    const m = bpCalls[0].style.match(/rgba\((\d+),(\d+),(\d+),([\d.]+)\)/);
    if (m) {
      const alpha = parseFloat(m[4]);
      const baseAlpha = 0.35;
      const boosted = Math.min(1, baseAlpha * BLUEPRINT_RESERVED_ALPHA_MULT);
      assert(
        Math.abs(alpha - boosted) < 0.001,
        `reserved fillStyle alpha=${alpha.toFixed(3)} ≈ boosted=${boosted.toFixed(3)}`,
      );
    } else {
      assert(false, `could not parse rgba from fillStyle='${bpCalls[0].style}'`);
    }
  }
}

// ===========================================================================
// [3] Off-screen blueprint → no fillRect (viewport cull)
// ===========================================================================
console.log('\n=== [3] Off-screen blueprint → no fillRect ===');
{
  resetQueue();
  fillRectCalls = [];

  // Place a blueprint FAR outside the viewport.
  // At CELL_SIZE px per cell and VW=400, viewport is 400/CELL_SIZE cells wide.
  // WORLD_W is at least 512; pick x = WORLD_W - 10 (far right, definitely off-screen
  // when camera.x=0 and viewport is only 400/CELL_SIZE cells wide).
  const OFF_X = Math.min(WORLD_W - 2, Math.ceil(VW / effCell) + 50);
  const OFF_Y = 3;

  const placed = addBlueprint(OFF_X, OFF_Y, 'wall');
  // If it didn't place (e.g. queue full or out of bounds), skip this sub-test.
  if (placed) {
    const canvas = makeCanvas(VW, VH);
    const ctx = makeCtx(VW, VH);
    canvas.getContext = () => ctx;
    initRenderer(canvas, ctx);
    const { getRenderer } = require('../src/render/renderer');
    fillRectCalls = [];
    getRenderer().render();

    const bpCalls = fillRectCalls.filter(c =>
      typeof c.style === 'string' && c.style.startsWith('rgba(')
    );
    assert(
      bpCalls.length === 0,
      `off-screen blueprint at x=${OFF_X} produces 0 fillRect calls (got ${bpCalls.length})`,
    );
  } else {
    console.log(`  SKIP: addBlueprint(${OFF_X},${OFF_Y},'wall') returned false (out-of-bounds or queue full)`);
  }
}

// ---------------------------------------------------------------------------
console.log(`\n${totalFailed === 0 ? 'OVERALL: PASS' : `OVERALL: FAIL (${totalFailed} failed)`}`);
process.exit(totalFailed === 0 ? 0 : 1);
