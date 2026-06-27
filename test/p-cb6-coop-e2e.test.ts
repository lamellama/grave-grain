declare const process: any;
/**
 * p-cb6-coop-e2e.test.ts — CB-6: cooperative base-building, END-TO-END through
 * main.ts's REAL tick path (GDD §6.2 Builder/Hauler, §8 building).
 *
 * Where p-bq3 isolated the builder loop by calling updateSurvivor directly, this
 * test drives the WHOLE cooperative loop through the SAME per-tick sequence
 * main.ts's simulationTick() runs — simulation.step() then updateSurvivor(s,
 * zombies) for each survivor — proving the queue → builder → grid handoff works
 * on the live path, and exercising the resetQueue() lifecycle main wires at
 * world (re)init.
 *
 * Done-when:
 *   1. FULL COOPERATIVE LOOP — seeded stockpile + a queued reachable fence + a
 *      survivor assigned 'builder': step the live loop to completion → blueprint
 *      GONE from the queue, the grid cell IS the fence material (WOOD), and the
 *      wood stockpile dropped by EXACTLY FENCE_COST once (no double-spend).
 *   2. NO-FUNDS — empty stockpile: the blueprint stays queued, unbuilt AND
 *      unreserved through the live loop (affordability gate holds).
 *   3. LIFECYCLE — after a build, resetQueue() empties getBlueprints(); a fresh
 *      blueprint queues clean (no stale reservation).
 */

import * as simulation from '../src/engine/simulation';
import { createSurvivor, updateSurvivor, assignRole } from '../src/characters/survivor';
import { makeTool } from '../src/game/roles';
import {
  addBlueprint,
  blueprintAt,
  getBlueprints,
  resetQueue,
} from '../src/game/buildqueue';
import { addResource, getStockpile, resetStockpile } from '../src/game/resources';
import { material, integrity, set, get } from '../src/engine/grid';
import { rebuildNavgrid } from '../src/engine/navgrid';
import { STONE, WOOD } from '../src/engine/materials';
import { P3_GROUND_Y, NEED_MAX, FENCE_COST } from '../src/config';

// ---------------------------------------------------------------------------
// Minimal assertion harness (mirrors p-bq3)
// ---------------------------------------------------------------------------
let totalFailed = 0;
function ok(condition: boolean, message: string): void {
  if (condition) {
    console.log(`  \u2713 ${message}`);
  } else {
    console.error(`  \u2717 ${message}`);
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
const BP_X = 128;

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
  s.tool = makeTool('hammer');
  assignRole(s, 'builder'); // the same call main.ts/the Assign tool uses
  return s;
}

/**
 * One LIVE game tick — the EXACT per-tick order main.ts's simulationTick() runs
 * for the building slice: advance the falling-sand CA, then drive each
 * survivor's controller (which contains the builder loop). Needs are kept topped
 * up so no self-preservation override pulls the builder off the job (isolates the
 * cooperative loop, not the needs interplay — same convention as p-bq3).
 */
function liveTick(survivors: ReturnType<typeof makeBuilder>[]): void {
  simulation.step();
  for (const s of survivors) {
    s.needs.hunger = NEED_MAX;
    s.needs.thirst = NEED_MAX;
    s.needs.warmth = NEED_MAX;
  }
  for (const s of survivors) {
    // Mirror main's gate (LOD): builders have a role so they always run, but we
    // drive them unconditionally here — the same effect for an active builder.
    updateSurvivor(s, []);
  }
}

// ===========================================================================
// 1. FULL COOPERATIVE LOOP through the live tick path
// ===========================================================================
label('1 full cooperative loop (queue -> builder -> grid) via live tick');
resetQueue();
resetStockpile();
flatFloor(100, 160);
addResource('wood', 5); // enough for several fences

ok(addBlueprint(BP_X, FEET, 'fence'), 'queued a fence blueprint on the floor row');
const bp = blueprintAt(BP_X, FEET)!;
const builder = makeBuilder(118); // 10 cells left of the blueprint
const woodBefore = getStockpile().wood;

// Drive the live loop to completion (walk + BUILD_TICKS + place). Generous
// budget; early-out once the cell is actualised.
let built = false;
for (let i = 0; i < 4000 && !built; i++) {
  liveTick([builder]);
  if (get(BP_X, FEET) === WOOD) built = true;
}
ok(built, 'blueprint cell actualised to WOOD via the live tick path (fence built)');
ok(blueprintAt(BP_X, FEET) === null, 'built blueprint left the queue');
ok(getBlueprints().length === 0, 'queue is empty after the build');
ok(
  getStockpile().wood === woodBefore - (FENCE_COST.wood ?? 0),
  `stockpile wood dropped by EXACTLY FENCE_COST once (${woodBefore} -> ${getStockpile().wood}, no double-spend)`,
);
ok(builder.buildTarget === null, 'claim cleared after build (buildTarget null)');

// ===========================================================================
// 2. NO-FUNDS — empty stockpile, gate holds through the live loop
// ===========================================================================
label('2 no-funds: affordability gate holds on the live path');
resetQueue();
resetStockpile(); // no wood at all
flatFloor(100, 160);
ok(addBlueprint(BP_X, FEET, 'fence'), 'queued a fence blueprint (broke colony)');
const bpPoor = blueprintAt(BP_X, FEET)!;
const poorBuilder = makeBuilder(118);
for (let i = 0; i < 200; i++) liveTick([poorBuilder]);
ok(poorBuilder.buildTarget === null, 'unaffordable blueprint was NEVER claimed');
ok(bpPoor.reserved === false, 'unaffordable blueprint stays unreserved');
ok(blueprintAt(BP_X, FEET) === bpPoor, 'unaffordable blueprint stays queued');
ok(get(BP_X, FEET) !== WOOD, 'nothing was built without materials');

// ===========================================================================
// 3. LIFECYCLE — resetQueue() clears state; fresh blueprint queues clean
// ===========================================================================
label('3 resetQueue lifecycle (world re-init seam main.ts wires)');
// Re-fund + build one so there is a real (reserved-then-cleared) history to wipe.
resetQueue();
resetStockpile();
flatFloor(100, 160);
addResource('wood', 5);
addBlueprint(BP_X, FEET, 'fence');
const lcBuilder = makeBuilder(118);
let lcBuilt = false;
for (let i = 0; i < 4000 && !lcBuilt; i++) {
  liveTick([lcBuilder]);
  if (get(BP_X, FEET) === WOOD) lcBuilt = true;
}
ok(lcBuilt, 'built a fence to create reservation history before reset');

// World re-init: resetQueue() as main.ts now calls.
resetQueue();
ok(getBlueprints().length === 0, 'resetQueue() empties the queue (no stale blueprints)');

// A fresh blueprint queues clean (unreserved) after the reset.
flatFloor(100, 160); // clear the built WOOD so the no-op guard doesn't reject
ok(addBlueprint(BP_X, FEET, 'wall'), 'a fresh blueprint queues after reset');
const freshBp = blueprintAt(BP_X, FEET)!;
ok(freshBp.reserved === false, 'fresh blueprint has no stale reservation');
ok(getBlueprints().length === 1, 'queue holds exactly the one fresh blueprint');

// ---------------------------------------------------------------------------
console.log(
  `\n${totalFailed === 0 ? 'OVERALL: PASS' : `OVERALL: FAIL (${totalFailed})`}`,
);
process.exit(totalFailed === 0 ? 0 : 1);
