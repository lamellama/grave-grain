declare const require: any;
declare const process: any;
/**
 * p-cb4-plantool.test.ts — CB-4: Plan tool queues/cancels blueprints (GDD §8).
 * Headless Node test over REAL modules (no mocks).
 *
 * Done-when:
 *   1. setToolMode('Plan','wall') + applyPlanAt → blueprintAt exists, grid unchanged, stockpile unchanged.
 *   2. Second applyPlanAt on same cell → blueprintAt is null (cancelled).
 *   3. Queue cap: adding > BUILD_QUEUE_MAX blueprints stops at cap.
 */

// ---------------------------------------------------------------------------
// DOM stub (mirrors p10-gesture.test.ts pattern — must be before any require)
// ---------------------------------------------------------------------------
function fakeEl(): any {
  return {
    width: 0, height: 0, style: {}, dataset: {},
    getContext() { return null; },
    getBoundingClientRect() { return { width: 1280, height: 720, left: 0, top: 0, right: 1280, bottom: 720 }; },
    addEventListener() {}, removeEventListener() {},
    setAttribute() {}, getAttribute() { return null; },
    classList: { add() {}, remove() {}, toggle() {} },
    appendChild() {}, querySelector() { return null; },
    textContent: '',
  };
}

const g: any = globalThis;
g.devicePixelRatio = 1;
g.requestAnimationFrame = (_fn: Function) => 1;
g.cancelAnimationFrame = () => {};
g.performance = g.performance || { now: () => Date.now() };
g.window = g;
g.document = {
  getElementById() { return fakeEl(); },
  querySelector() { return fakeEl(); },
  querySelectorAll() { return [] as any; },
  createElement() { return fakeEl(); },
  addEventListener() {}, removeEventListener() {},
  body: fakeEl(),
};
g.addEventListener = () => {};

// ---------------------------------------------------------------------------
// Load modules via require (after DOM stub)
// ---------------------------------------------------------------------------
const { setToolMode, applyPlanAt } = require('../src/input');
const { blueprintAt, resetQueue, getBlueprints } = require('../src/game/buildqueue');
const { getStockpile, resetStockpile, addResource } = require('../src/game/resources');
const { material, integrity, set, get } = require('../src/engine/grid');
const { STONE } = require('../src/engine/materials');
const { P3_GROUND_Y, BUILD_QUEUE_MAX } = require('../src/config');

// ---------------------------------------------------------------------------
// Minimal assertion harness
// ---------------------------------------------------------------------------
let totalFailed = 0;
function ok(condition: boolean, message: string): void {
  if (condition) {
    console.log(`  ✓ ${message}`);
  } else {
    console.error(`  ✗ ${message}`);
    totalFailed++;
  }
}
function label(name: string): void {
  console.log(`\n=== ${name} ===`);
}

// ---------------------------------------------------------------------------
// Scene setup: flat world with a known ground row
// ---------------------------------------------------------------------------
const FLOOR: number = P3_GROUND_Y;
const FEET: number = FLOOR - 1; // open-air cell directly above the stone floor

function flatFloor(): void {
  material.fill(0);
  integrity.fill(0);
  for (let x = 0; x < 256; x++) set(x, FLOOR, STONE);
}

// ===========================================================================
// 1. Plan tap → blueprint queued, grid unchanged, stockpile unchanged
// ===========================================================================
label('1 Plan tap queues blueprint (grid + stockpile untouched)');
resetQueue();
resetStockpile();
addResource('wood', 10);
addResource('stone', 10);
flatFloor();

const woodBefore: number = getStockpile().wood;
const stoneBefore: number = getStockpile().stone;
const cellX = 50;
const cellY: number = FEET;
const cellBefore: number = get(cellX, cellY);

setToolMode('Plan', 'wall');
applyPlanAt(cellX, cellY);

const bp = blueprintAt(cellX, cellY);
ok(bp !== null, 'blueprintAt returns a blueprint after applyPlanAt');
ok(bp?.kind === 'wall', `blueprint kind is 'wall' (got '${bp?.kind}')`);
ok(get(cellX, cellY) === cellBefore, 'grid cell is unchanged after plan (no immediate build)');
ok(getStockpile().wood === woodBefore, 'wood stockpile is unchanged at plan time');
ok(getStockpile().stone === stoneBefore, 'stone stockpile is unchanged at plan time');

// ===========================================================================
// 2. Second tap on same cell → cancelled
// ===========================================================================
label('2 Second tap cancels the blueprint (toggle)');
applyPlanAt(cellX, cellY);
ok(blueprintAt(cellX, cellY) === null, 'blueprintAt is null after second tap (cancelled)');
ok(getBlueprints().length === 0, 'queue is empty after cancel');

// ===========================================================================
// 3. Queue cap: no blueprint added beyond BUILD_QUEUE_MAX
// ===========================================================================
label('3 Queue cap enforced');
resetQueue();
setToolMode('Plan', 'wall');

// Fill the queue to the cap using different x positions
let added = 0;
for (let x = 0; x < BUILD_QUEUE_MAX + 5; x++) {
  applyPlanAt(x, FEET);
  if (blueprintAt(x, FEET) !== null) added++;
}
ok(getBlueprints().length === BUILD_QUEUE_MAX, `queue stops at BUILD_QUEUE_MAX (${BUILD_QUEUE_MAX})`);
ok(added === BUILD_QUEUE_MAX, `exactly BUILD_QUEUE_MAX blueprints were successfully added (got ${added})`);

// ===========================================================================
// Summary
// ===========================================================================
console.log(
  `\n${totalFailed === 0 ? 'OVERALL: PASS' : `OVERALL: FAIL (${totalFailed})`}`,
);
process.exit(totalFailed === 0 ? 0 : 1);
