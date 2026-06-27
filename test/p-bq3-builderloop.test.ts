declare const process: any;
/**
 * p-bq3-builderloop.test.ts — BQ-3: survivor builder construction loop
 * (GDD §6.2 / §8). Headless Node test over REAL modules (no mocks).
 *
 * The builder is the queue-driven sibling of the harvest roles: it claims a
 * player Blueprint, walks to a standable bank beside it, works BUILD_TICKS, then
 * placeStructure()s the cell (atomic stockpile spend) and dequeues the job.
 *
 * Done-when:
 *   1. CLAIM — an assigned builder near a queued, affordable blueprint claims it
 *      within a few ticks: s.buildTarget points at the bp and bp.reserved=true.
 *   2. BUILD — driven to completion, the cell becomes the structure material
 *      (WOOD for a fence), the blueprint leaves the queue, stockpile wood drops
 *      by FENCE_COST, and the claim clears (buildTarget=null).
 *   3. AFFORDABILITY GATE — with an empty stockpile the builder NEVER claims the
 *      blueprint (canPlace gate): buildTarget stays null, bp stays unreserved.
 *   4. CANCEL — cancelling a claimed blueprint mid-walk makes the builder drop
 *      the stale claim (buildTarget=null) and not crash; queue ends empty.
 *   5. ASSIGN-RELEASE — clearing a builder's role (assignRole 'none') releases
 *      its claimed blueprint (reserved=false) so another builder can take it.
 *   6. NO DOUBLE-CLAIM — two builders, one blueprint: exactly one reserves it.
 *   7. npm run build green (verified separately).
 */

import { createSurvivor, updateSurvivor, assignRole } from '../src/characters/survivor';
import { makeTool } from '../src/game/roles';
import {
  addBlueprint,
  blueprintAt,
  cancelBlueprintAt,
  getBlueprints,
  resetQueue,
} from '../src/game/buildqueue';
import { addResource, getStockpile, resetStockpile } from '../src/game/resources';
import { material, integrity, set, get } from '../src/engine/grid';
import { rebuildNavgrid } from '../src/engine/navgrid';
import { STONE, WOOD } from '../src/engine/materials';
import { P3_GROUND_Y, NEED_MAX, FENCE_COST } from '../src/config';

// ---------------------------------------------------------------------------
// Minimal assertion harness (mirrors p-bq1/p-bq2)
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
// Scene helpers
// ---------------------------------------------------------------------------
const FLOOR = P3_GROUND_Y;
const FEET = FLOOR - 1; // standable row directly above the stone floor

/** Wipe the world and lay a flat stone floor over [x0, x1]. */
function flatFloor(x0: number, x1: number): void {
  material.fill(0);
  integrity.fill(0);
  for (let x = x0; x <= x1; x++) set(x, FLOOR, STONE);
  rebuildNavgrid();
}

/** A builder survivor with a hammer (bypasses crafting), placed at feet (x). */
function makeBuilder(x: number) {
  const s = createSurvivor(x, FEET);
  s.role = 'builder';
  s.tool = makeTool('hammer');
  s.roleState = 'toTarget';
  return s;
}

/** Keep needs topped up so no self-preservation override pulls the builder off
 *  the job — this test isolates the construction loop, not the needs interplay. */
function tick(survivors: ReturnType<typeof makeBuilder>[]): void {
  for (const s of survivors) {
    s.needs.hunger = NEED_MAX;
    s.needs.thirst = NEED_MAX;
    s.needs.warmth = NEED_MAX;
  }
  for (const s of survivors) updateSurvivor(s, []);
}

// ===========================================================================
// 1 + 2. CLAIM then BUILD-TO-COMPLETION
// ===========================================================================
label('1+2 claim then build to completion');
resetQueue();
resetStockpile();
flatFloor(100, 160);
addResource('wood', 5); // enough for several fences

const BP_X = 128;
ok(addBlueprint(BP_X, FEET, 'fence'), 'queued a fence blueprint on the floor row');
const bp = blueprintAt(BP_X, FEET)!;

const builder = makeBuilder(118); // 10 cells left of the blueprint
const woodBefore = getStockpile().wood;

// A few ticks to claim + reserve.
for (let i = 0; i < 10; i++) tick([builder]);
ok(builder.buildTarget === bp, 'builder claimed the nearest blueprint (buildTarget === bp)');
ok(bp.reserved === true, 'claimed blueprint is reserved');

// Drive to completion (walk + BUILD_TICKS + place). Generous budget; early-out.
let built = false;
for (let i = 0; i < 4000 && !built; i++) {
  tick([builder]);
  if (get(BP_X, FEET) === WOOD) built = true;
}
ok(built, 'blueprint cell was actualised to WOOD (fence built)');
ok(blueprintAt(BP_X, FEET) === null, 'built blueprint left the queue');
ok(getBlueprints().length === 0, 'queue is empty after the build');
ok(
  getStockpile().wood === woodBefore - (FENCE_COST.wood ?? 0),
  `stockpile wood dropped by FENCE_COST (${woodBefore} → ${getStockpile().wood})`,
);
ok(builder.buildTarget === null, 'claim cleared after build (buildTarget null)');

// ===========================================================================
// 3. AFFORDABILITY GATE — empty stockpile → never claim
// ===========================================================================
label('3 affordability gate (empty stockpile)');
resetQueue();
resetStockpile(); // no wood at all
flatFloor(100, 160);
ok(addBlueprint(BP_X, FEET, 'fence'), 'queued a fence blueprint');
const bpPoor = blueprintAt(BP_X, FEET)!;
const poorBuilder = makeBuilder(118);
for (let i = 0; i < 50; i++) tick([poorBuilder]);
ok(poorBuilder.buildTarget === null, 'unaffordable blueprint was NOT claimed');
ok(bpPoor.reserved === false, 'unaffordable blueprint stays unreserved');
ok(get(BP_X, FEET) !== WOOD, 'nothing was built without materials');

// ===========================================================================
// 4. CANCEL mid-walk → stale claim dropped
// ===========================================================================
label('4 cancel claimed blueprint mid-walk');
resetQueue();
resetStockpile();
flatFloor(100, 160);
addResource('wood', 5);
addBlueprint(BP_X, FEET, 'fence');
const cancelBuilder = makeBuilder(102); // far enough to still be walking
for (let i = 0; i < 6; i++) tick([cancelBuilder]); // let it claim + start walking
ok(cancelBuilder.buildTarget !== null, 'builder claimed before cancel');
ok(cancelBlueprintAt(BP_X, FEET), 'player cancelled the blueprint mid-walk');
// Keep ticking — builder must notice the stale claim and drop it, no crash.
for (let i = 0; i < 20; i++) tick([cancelBuilder]);
ok(cancelBuilder.buildTarget === null, 'builder dropped the cancelled (stale) claim');
ok(getBlueprints().length === 0, 'queue empty (cancelled job is gone)');
ok(get(BP_X, FEET) !== WOOD, 'cancelled job was never built');

// ===========================================================================
// 5. ASSIGN-RELEASE — clearing role hands the claim back
// ===========================================================================
label('5 assignRole(none) releases the claim');
resetQueue();
resetStockpile();
flatFloor(100, 160);
addResource('wood', 5);
addBlueprint(BP_X, FEET, 'fence');
const relBuilder = makeBuilder(118);
for (let i = 0; i < 10; i++) tick([relBuilder]);
const relBp = blueprintAt(BP_X, FEET)!;
ok(relBuilder.buildTarget === relBp && relBp.reserved, 'builder holds a reserved claim');
assignRole(relBuilder, 'none');
ok(relBuilder.buildTarget === null, 'cleared builder dropped its local handle');
ok(relBp.reserved === false, 'released blueprint is re-claimable (reserved=false)');

// ===========================================================================
// 6. NO DOUBLE-CLAIM — two builders, one blueprint
// ===========================================================================
label('6 two builders never double-claim one blueprint');
resetQueue();
resetStockpile();
flatFloor(100, 160);
addResource('wood', 5);
addBlueprint(BP_X, FEET, 'fence');
const b1 = makeBuilder(116);
const b2 = makeBuilder(140);
const both = [b1, b2];
for (let i = 0; i < 10; i++) tick(both);
const claimants = both.filter(b => b.buildTarget !== null).length;
ok(claimants === 1, `exactly one builder claimed the blueprint (got ${claimants})`);

// ---------------------------------------------------------------------------
console.log(
  `\n${totalFailed === 0 ? 'OVERALL: PASS' : `OVERALL: FAIL (${totalFailed})`}`,
);
process.exit(totalFailed === 0 ? 0 : 1);
