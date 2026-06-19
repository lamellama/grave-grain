declare const require: any;
declare const process: any;
/**
 * p9-ui.test.ts — headless unit tests for src/game/ui.ts (task 9-5).
 *
 * Tests:
 *   1. cycleSimSpeed() walks SIM_SPEEDS [1,2,3] and wraps back to 1.
 *   2. getSimSpeed() reflects the current value after each cycle.
 *   3. pushToast() / _toastCount() — queue fills and prunes at the cap.
 *
 * DOM-free: the module only references Date.now() and the camera module
 * (worldToScreen is only called from draw* functions, not from the
 * speed/toast helpers tested here). We stub only what is strictly needed.
 */

// ---------------------------------------------------------------------------
// Minimal stubs so camera.ts and config.ts import without error
// ---------------------------------------------------------------------------
// camera.ts does nothing at module level besides export constants/functions;
// no DOM touch needed.

const g: any = globalThis;
g.performance = g.performance || { now: () => Date.now() };

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
// Import the module under test
// ---------------------------------------------------------------------------

const ui = require('../src/game/ui');
const cycleSimSpeed: () => number = ui.cycleSimSpeed;
const getSimSpeed: () => number = ui.getSimSpeed;
const pushToast: (msg: string) => void = ui.pushToast;
const _toastCount: () => number = ui._toastCount;

// ---------------------------------------------------------------------------
// 1. Speed cycling (SIM_SPEEDS = [1, 2, 3])
// ---------------------------------------------------------------------------
console.log('\n--- Speed cycling ---');

// The module-level index starts at 0 (speed = 1). Each cycleSimSpeed() call
// advances it, wrapping after the last element.

assert(getSimSpeed() === 1, 'initial speed is 1×');

const s1 = cycleSimSpeed();
assert(s1 === 2, 'cycleSimSpeed() → 2 (first advance)');
assert(getSimSpeed() === 2, 'getSimSpeed() reflects 2 after first cycle');

const s2 = cycleSimSpeed();
assert(s2 === 3, 'cycleSimSpeed() → 3 (second advance)');
assert(getSimSpeed() === 3, 'getSimSpeed() reflects 3 after second cycle');

const s3 = cycleSimSpeed();
assert(s3 === 1, 'cycleSimSpeed() wraps back to 1 (third advance)');
assert(getSimSpeed() === 1, 'getSimSpeed() reflects 1 after wrap');

// Another full cycle to confirm wrapping is consistent.
cycleSimSpeed(); // → 2
cycleSimSpeed(); // → 3
const s4 = cycleSimSpeed(); // → 1 again
assert(s4 === 1, 'second wrap also lands at 1');

// ---------------------------------------------------------------------------
// 2. Toast queue: push and cap
// ---------------------------------------------------------------------------
console.log('\n--- Toast queue ---');

// Count before any pushes (may already have 0 from a fresh module load).
const countBefore = _toastCount();
assert(countBefore === 0, 'toast queue starts empty');

pushToast('Test message A');
assert(_toastCount() === 1, 'one toast after first push');

pushToast('Test message B');
pushToast('Test message C');
assert(_toastCount() === 3, 'three toasts after three pushes');

// Push beyond cap (5). Queue should stay at 5.
pushToast('D');
pushToast('E');
pushToast('F'); // This 6th push should drop the oldest.
assert(_toastCount() === 5, 'queue capped at 5 (oldest dropped)');

pushToast('G');
assert(_toastCount() === 5, 'queue still capped at 5 after seventh push');

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('FAIL: p9-ui tests failed');
  process.exit(1);
} else {
  console.log('PASS: p9-ui all tests passed');
}
