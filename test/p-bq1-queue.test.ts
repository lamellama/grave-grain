/**
 * p-bq1-queue.test.ts — BQ-1: global blueprint queue (GDD §6.2 / §8)
 *
 * Headless Node test (real modules, no mocks). Covers all Done-when checks.
 *
 * Done-when:
 *   1. addBlueprint adds a valid cell (true, length 1); dup → false, no grow;
 *      out-of-bounds → false.
 *   2. Cap: filling ~300 distinct in-bounds cells → exactly BUILD_QUEUE_MAX (256);
 *      further adds return false.
 *   3. blueprintAt / cancelBlueprintAt / removeBlueprint / reserve / release.
 *   4. addBlueprint over a cell that already holds the structure's material → false.
 *   5. resetQueue empties the queue.
 *   6. npm run build green (verified separately).
 */

import {
  addBlueprint,
  getBlueprints,
  blueprintAt,
  cancelBlueprintAt,
  removeBlueprint,
  reserve,
  release,
  resetQueue,
} from '../src/game/buildqueue';
import { material, idx } from '../src/engine/grid';
import { WALL } from '../src/engine/materials';
import { BUILD_QUEUE_MAX, WORLD_W, WORLD_H } from '../src/config';

declare const process: any;

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let totalFailed = 0;

function label(name: string): void {
  console.log(`\n=== ${name} ===`);
}

function ok(cond: boolean, msg: string): boolean {
  if (cond) {
    console.log('  PASS:', msg);
  } else {
    console.error('  FAIL:', msg);
    totalFailed++;
  }
  return cond;
}

// ---------------------------------------------------------------------------
// A1 — Basic add, dedup, out-of-bounds
// ---------------------------------------------------------------------------
label('A1 addBlueprint: add / dedup / out-of-bounds');

resetQueue();

// Valid add: x=10, y=10, kind='fence' — cell is AIR (0) at start
const r1 = addBlueprint(10, 10, 'fence');
ok(r1 === true, `addBlueprint(10,10,'fence') returns true`);
ok(getBlueprints().length === 1, `queue length is 1 after first add`);

// Duplicate: same (x,y) → false, length unchanged
const r2 = addBlueprint(10, 10, 'fence');
ok(r2 === false, `duplicate addBlueprint(10,10,'fence') returns false`);
ok(getBlueprints().length === 1, `queue length unchanged (still 1) after dup`);

// Different kind, same coords → still a dup
const r2b = addBlueprint(10, 10, 'wall');
ok(r2b === false, `duplicate addBlueprint(10,10,'wall') returns false`);
ok(getBlueprints().length === 1, `queue length unchanged (still 1) after cross-kind dup`);

// Out-of-bounds
const r3 = addBlueprint(-1, 10, 'fence');
ok(r3 === false, `addBlueprint(-1,10,'fence') returns false (x<0)`);
const r4 = addBlueprint(WORLD_W, 10, 'fence');
ok(r4 === false, `addBlueprint(WORLD_W,10,'fence') returns false (x>=WORLD_W)`);
const r5 = addBlueprint(10, -1, 'fence');
ok(r5 === false, `addBlueprint(10,-1,'fence') returns false (y<0)`);
const r6 = addBlueprint(10, WORLD_H, 'fence');
ok(r6 === false, `addBlueprint(10,WORLD_H,'fence') returns false (y>=WORLD_H)`);
ok(getBlueprints().length === 1, `queue length still 1 after all rejected adds`);

// ---------------------------------------------------------------------------
// A2 — Cap at BUILD_QUEUE_MAX (256)
// ---------------------------------------------------------------------------
label(`A2 Cap at BUILD_QUEUE_MAX (${BUILD_QUEUE_MAX})`);

resetQueue();

// Fill well above the cap using distinct (x,y) pairs (row 5, cols 0..299)
const ATTEMPTS = 300;
let successCount = 0;
for (let i = 0; i < ATTEMPTS; i++) {
  // Spread across two rows to stay in bounds (WORLD_W >= 1280)
  const x = i % WORLD_W;
  const y = 5 + Math.floor(i / WORLD_W);
  if (addBlueprint(x, y, 'fence')) successCount++;
}

ok(
  getBlueprints().length === BUILD_QUEUE_MAX,
  `queue capped at BUILD_QUEUE_MAX=${BUILD_QUEUE_MAX} (got ${getBlueprints().length})`,
);
ok(successCount === BUILD_QUEUE_MAX, `only ${BUILD_QUEUE_MAX} of ${ATTEMPTS} adds succeeded`);

// Any additional distinct in-bounds cell must also fail
const overflowResult = addBlueprint(0, 20, 'fence');
ok(overflowResult === false, `add when at cap returns false`);
ok(getBlueprints().length === BUILD_QUEUE_MAX, `length still ${BUILD_QUEUE_MAX} after overflow attempt`);

// ---------------------------------------------------------------------------
// A3 — blueprintAt / cancelBlueprintAt / removeBlueprint / reserve / release
// ---------------------------------------------------------------------------
label('A3 blueprintAt / cancel / remove / reserve / release');

resetQueue();
addBlueprint(30, 30, 'wall');
addBlueprint(31, 30, 'fence');

// blueprintAt finds a queued cell
const found = blueprintAt(30, 30);
ok(found !== null, `blueprintAt(30,30) returns a Blueprint (not null)`);
ok(found?.kind === 'wall', `blueprintAt(30,30).kind === 'wall'`);

// blueprintAt returns null for an absent cell
ok(blueprintAt(99, 99) === null, `blueprintAt(99,99) returns null (not queued)`);

// cancelBlueprintAt: true when present, removes it
const cancelled = cancelBlueprintAt(30, 30);
ok(cancelled === true, `cancelBlueprintAt(30,30) returns true`);
ok(getBlueprints().length === 1, `length is 1 after cancel`);
ok(blueprintAt(30, 30) === null, `blueprintAt(30,30) returns null after cancel`);

// cancelBlueprintAt: false when absent
const cancelledAgain = cancelBlueprintAt(30, 30);
ok(cancelledAgain === false, `cancelBlueprintAt(30,30) returns false when already removed`);

// removeBlueprint: splices specific object
const bp31 = blueprintAt(31, 30)!;
ok(bp31 !== null, `blueprintAt(31,30) is non-null before removeBlueprint`);
removeBlueprint(bp31);
ok(getBlueprints().length === 0, `length is 0 after removeBlueprint`);
ok(blueprintAt(31, 30) === null, `blueprintAt(31,30) is null after removeBlueprint`);

// removeBlueprint is no-op on a detached object
removeBlueprint(bp31); // must not throw or grow queue
ok(getBlueprints().length === 0, `removeBlueprint on detached object is a no-op`);

// reserve / release toggle bp.reserved
resetQueue();
addBlueprint(50, 50, 'fence');
const bpRes = blueprintAt(50, 50)!;
ok(bpRes.reserved === false, `blueprint starts with reserved=false`);
reserve(bpRes);
ok(bpRes.reserved === true, `reserve() sets reserved=true`);
release(bpRes);
ok(bpRes.reserved === false, `release() clears reserved back to false`);

// reserve/release are identity operations on bp.reserved; safe to call twice
reserve(bpRes);
reserve(bpRes);
ok(bpRes.reserved === true, `double reserve() leaves reserved=true`);
release(bpRes);
release(bpRes);
ok(bpRes.reserved === false, `double release() leaves reserved=false`);

// ---------------------------------------------------------------------------
// A4 — Already-built cell rejected (material == structure's material)
// ---------------------------------------------------------------------------
label('A4 addBlueprint over already-built cell returns false');

resetQueue();

// Seed the material array directly: place WALL (id 14) at (60, 60)
material[idx(60, 60)] = WALL;

// Attempt to queue a 'wall' blueprint there — should be rejected (nothing to build)
const r7 = addBlueprint(60, 60, 'wall');
ok(r7 === false, `addBlueprint(60,60,'wall') returns false when cell is already WALL`);
ok(getBlueprints().length === 0, `queue length remains 0 after material-match reject`);

// A different kind at a non-matching cell is still accepted
// material[idx(60,60)] == WALL == 14, which is NOT WOOD (6, used by 'fence')
const r8 = addBlueprint(60, 60, 'fence');
ok(r8 === true, `addBlueprint(60,60,'fence') returns true (WALL != WOOD so fence can be placed)`);
ok(getBlueprints().length === 1, `queue has 1 blueprint after valid add over WALL cell for fence`);

// Restore cell to AIR for cleanliness
material[idx(60, 60)] = 0;

// ---------------------------------------------------------------------------
// A5 — resetQueue empties
// ---------------------------------------------------------------------------
label('A5 resetQueue empties the queue');

resetQueue();
addBlueprint(1, 1, 'fence');
addBlueprint(2, 2, 'wall');
ok(getBlueprints().length === 2, `setup: queue has 2 items before reset`);

resetQueue();
ok(getBlueprints().length === 0, `resetQueue() empties the queue`);
ok(addBlueprint(1, 1, 'fence') === true, `addBlueprint succeeds after resetQueue (fresh state)`);
ok(getBlueprints().length === 1, `length is 1 after add post-reset`);

// ---------------------------------------------------------------------------
// SUMMARY
// ---------------------------------------------------------------------------
console.log('\n══════════════════════════════════════════════════════');
const allPass = totalFailed === 0;
console.log(allPass ? 'OVERALL: PASS' : `OVERALL: FAIL (${totalFailed} assertion(s) failed)`);
console.log('══════════════════════════════════════════════════════');
process.exit(allPass ? 0 : 1);
