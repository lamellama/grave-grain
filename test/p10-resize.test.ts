declare const require: any;
declare const process: any;
/**
 * p10-resize.test.ts — resize/orientation invariant test for task 10-7.
 *
 * Confirms that after a resize or orientationchange:
 *   floor(rect.w) == canvas.width == renderer.viewportWidthPx
 *   floor(rect.h) == canvas.height == renderer.viewportHeightPx
 *
 * This is the critical ImageData == backing-store invariant: if canvas.width
 * != viewportWidthPx the putImageData(imageData, 0, 0) only fills part of the
 * canvas (the hi-DPI corner bug — GDD §12.4 keep cells chunky).
 *
 * Strategy: boot main.ts with a fully-stubbed DOM (same pattern as
 * main-smoke.test.ts) but (a) return the SAME canvasStub object for
 * getElementById('game') so we can mutate its getBoundingClientRect return
 * value, and (b) capture window.addEventListener calls so we can invoke the
 * 'resize' and 'orientationchange' handlers directly.
 */

// ---------------------------------------------------------------------------
// DOM stubs — constructed BEFORE require('../src/main') so they are in place
// when main.ts top-level code executes.
// ---------------------------------------------------------------------------

// Mutable viewport rect — change this to simulate a resize / phone rotation.
const viewportRect = { width: 1280, height: 720 };

function fakeCtx(): any {
  return {
    fillStyle: '#000', font: '', textAlign: 'left',
    save(){}, restore(){}, scale(){},
    fillRect(){},
    fillText(){},
    createImageData(w: number, h: number) {
      return { data: new Uint8ClampedArray(Math.max(1, w * h * 4)), width: w, height: h };
    },
    putImageData(){},
    measureText() { return { width: 0 }; },
  };
}

// The one canvas the game binds to.  We keep a reference so we can read back
// canvas.width / canvas.height after resizeCanvas() runs.
const canvasStub: any = {
  width: 0,
  height: 0,
  style: {},
  dataset: {},
  getContext() { return fakeCtx(); },
  // Return the mutable viewportRect so changing it simulates a CSS resize.
  getBoundingClientRect() {
    return {
      width: viewportRect.width,
      height: viewportRect.height,
      left: 0, top: 0,
      right: viewportRect.width,
      bottom: viewportRect.height,
    };
  },
  addEventListener() {},
  removeEventListener() {},
  setAttribute() {},
  getAttribute() { return null; },
  classList: { add(){}, remove(){}, toggle(){} },
  appendChild() {},
  querySelector() { return null; },
  textContent: '',
};

function fakeEl(): any {
  return {
    width: 0, height: 0, style: {}, dataset: {},
    getContext() { return fakeCtx(); },
    getBoundingClientRect() {
      return { width: 320, height: 50, left: 0, top: 0, right: 320, bottom: 50 };
    },
    addEventListener() {},
    removeEventListener() {},
    setAttribute() {},
    getAttribute() { return null; },
    classList: { add(){}, remove(){}, toggle(){} },
    appendChild() {},
    querySelector() { return null; },
    textContent: '',
  };
}

// Capture window-level event listeners so we can invoke them in the test.
const windowListeners: Record<string, Array<(...args: any[]) => void>> = {};

const g: any = globalThis;
g.devicePixelRatio = 2;
g.requestAnimationFrame = (_fn: Function) => 1; // don't spin the loop
g.cancelAnimationFrame = () => {};
g.performance = g.performance || { now: () => Date.now() };
g.window = g;
g.document = {
  getElementById(id: string) {
    // Return the shared canvasStub for the game canvas so we can inspect it.
    return id === 'game' ? canvasStub : fakeEl();
  },
  querySelector() { return fakeEl(); },
  querySelectorAll() { return [] as any; },
  createElement() { return fakeEl(); },
  addEventListener() {},
  removeEventListener() {},
  body: fakeEl(),
};
// Capture window.addEventListener calls.
g.addEventListener = (event: string, fn: (...args: any[]) => void) => {
  if (!windowListeners[event]) windowListeners[event] = [];
  windowListeners[event].push(fn);
};

// ---------------------------------------------------------------------------
// Boot main.ts
// ---------------------------------------------------------------------------
let threw: any = null;
try {
  require('../src/main');
} catch (e) { threw = e; }

console.log('threw:', threw ? (threw.message || String(threw)) : 'none');
if (threw) {
  console.log('FAIL: main.ts threw on load');
  process.exit(1);
}

const { getRenderer } = require('../src/render/renderer');
const renderer = getRenderer();

// ---------------------------------------------------------------------------
// Helpers
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

function fireListeners(event: string): void {
  (windowListeners[event] || []).forEach(fn => fn());
}

// ---------------------------------------------------------------------------
// [1] Initial state at 1280×720 — set by the resizeCanvas() call in main.ts
// ---------------------------------------------------------------------------
console.log('\n[1] Initial backing-store invariant at 1280×720');
const W0 = Math.floor(1280);
const H0 = Math.floor(720);
assert(canvasStub.width === W0,
  `canvas.width=${canvasStub.width} == floor(rect.w)=${W0}`);
assert(canvasStub.height === H0,
  `canvas.height=${canvasStub.height} == floor(rect.h)=${H0}`);
assert(renderer.viewportWidthPx === W0,
  `renderer.viewportWidthPx=${renderer.viewportWidthPx} == ${W0}`);
assert(renderer.viewportHeightPx === H0,
  `renderer.viewportHeightPx=${renderer.viewportHeightPx} == ${H0}`);

// ---------------------------------------------------------------------------
// [2] Simulate window 'resize' (landscape→portrait via resize event)
// ---------------------------------------------------------------------------
console.log('\n[2] window resize to 568×320');
viewportRect.width = 568;
viewportRect.height = 320;

const resizeListeners = windowListeners['resize'] || [];
assert(resizeListeners.length >= 1,
  `window 'resize' listener registered (got ${resizeListeners.length})`);

fireListeners('resize');

const W1 = Math.floor(568);
const H1 = Math.floor(320);
assert(canvasStub.width === W1,
  `canvas.width=${canvasStub.width} == floor(568)=${W1}`);
assert(canvasStub.height === H1,
  `canvas.height=${canvasStub.height} == floor(320)=${H1}`);
assert(renderer.viewportWidthPx === W1,
  `renderer.viewportWidthPx=${renderer.viewportWidthPx} == ${W1}`);
assert(renderer.viewportHeightPx === H1,
  `renderer.viewportHeightPx=${renderer.viewportHeightPx} == ${H1}`);

// ---------------------------------------------------------------------------
// [3] orientationchange listener is registered (task 10-7 requirement)
// ---------------------------------------------------------------------------
console.log('\n[3] orientationchange listener registered');
const orientListeners = windowListeners['orientationchange'] || [];
assert(orientListeners.length >= 1,
  `window 'orientationchange' listener registered (got ${orientListeners.length})`);

// ---------------------------------------------------------------------------
// [4] Simulate orientationchange (portrait→landscape on phone)
// ---------------------------------------------------------------------------
console.log('\n[4] orientationchange to 720×1280 (portrait phone)');
viewportRect.width = 720;
viewportRect.height = 1280;
fireListeners('orientationchange');

const W2 = Math.floor(720);
const H2 = Math.floor(1280);
assert(canvasStub.width === W2,
  `canvas.width=${canvasStub.width} == floor(720)=${W2}`);
assert(canvasStub.height === H2,
  `canvas.height=${canvasStub.height} == floor(1280)=${H2}`);
assert(renderer.viewportWidthPx === W2,
  `renderer.viewportWidthPx=${renderer.viewportWidthPx} == ${W2}`);
assert(renderer.viewportHeightPx === H2,
  `renderer.viewportHeightPx=${renderer.viewportHeightPx} == ${H2}`);

// ---------------------------------------------------------------------------
// [5] Fractional CSS sizes are floored (simulates sub-pixel rect on mobile)
// ---------------------------------------------------------------------------
console.log('\n[5] Fractional rect is floored (375.6×667.8)');
viewportRect.width = 375.6;
viewportRect.height = 667.8;
fireListeners('orientationchange');

const W3 = Math.floor(375.6); // 375
const H3 = Math.floor(667.8); // 667
assert(canvasStub.width === W3,
  `canvas.width=${canvasStub.width} == floor(375.6)=${W3}`);
assert(canvasStub.height === H3,
  `canvas.height=${canvasStub.height} == floor(667.8)=${H3}`);
assert(renderer.viewportWidthPx === W3,
  `renderer.viewportWidthPx=${renderer.viewportWidthPx} == ${W3}`);
assert(renderer.viewportHeightPx === H3,
  `renderer.viewportHeightPx=${renderer.viewportHeightPx} == ${H3}`);

// ---------------------------------------------------------------------------
// [6] canvas.width == renderer.viewportWidthPx (ImageData == backing store)
// ---------------------------------------------------------------------------
console.log('\n[6] canvas.width == renderer.viewportWidthPx at every size checked');
// Already verified per-case; a final consolidated assertion.
assert(canvasStub.width === renderer.viewportWidthPx,
  `canvas.width(${canvasStub.width}) === renderer.viewportWidthPx(${renderer.viewportWidthPx}) [ImageData fills canvas]`);
assert(canvasStub.height === renderer.viewportHeightPx,
  `canvas.height(${canvasStub.height}) === renderer.viewportHeightPx(${renderer.viewportHeightPx}) [ImageData fills canvas]`);

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\np10-resize: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('FAIL');
  process.exit(1);
}
console.log('PASS');
