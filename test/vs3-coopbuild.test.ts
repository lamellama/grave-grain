declare const process: any;
/**
 * vs3-coopbuild.test.ts - VS-3 T3: cooperative shelter build WIRING
 * (coopbuild.ts, GDD 8/6.1/13). Headless Node test over REAL modules (no mocks).
 *
 * T3 is the glue between a group's shelter PROJECT (shelter.ts) and the global
 * builder machinery (buildqueue.ts + the survivor builder loop). It owns no build
 * AI: it STREAMS project cells into the one queue a few at a time (MAX_BUILD_CLAIMS
 * cap), lights a campfire once the shell encloses, releases a dead builder's
 * claim, and abandons a group's queued cells on demand. The builders divide the
 * work for free via the existing reserve mechanism.
 *
 * Done-when:
 *   1. STREAM + CAP - updateCoopBuild over a co-located group queues THIS group's
 *      project cells, never more than MAX_BUILD_CLAIMS live at once, bottom-up.
 *   2. TOP-UP + DIVISION - real builders claim distinct streamed cells (no double-
 *      claim), build the reachable lower course, and the capped pool refills as
 *      cells complete (remaining unbuilt count strictly drops).
 *   3. CAMPFIRE ON ENCLOSE - no campfire is queued while the shell is incomplete;
 *      once every shell cell is its material, streamProject queues exactly one
 *      campfire blueprint on the interior floor (and only one).
 *   4. RELEASE ON DEATH - a builder that dies holding a reserved claim frees it
 *      (reserved=false) so the job is re-claimable; no orphaned deadlock.
 *   5. ABANDON - clearGroupBuild cancels a group's UNRESERVED queued cells but
 *      leaves RESERVED ones for their builder (no cancel-out-from-under).
 */

import {
  WORLD_W,
  MAX_BUILD_CLAIMS,
  NEED_MAX,
} from '../src/config';
import { STONE, AIR, WALL, WOOD, CAMPFIRE } from '../src/engine/materials';
import { material, integrity, set, get, placeMaterial } from '../src/engine/grid';
import { rebuildNavgrid } from '../src/engine/navgrid';
import {
  createSurvivor,
  updateSurvivor,
  type Survivor,
} from '../src/characters/survivor';
import { makeTool } from '../src/game/roles';
import { addResource, resetStockpile } from '../src/game/resources';
import {
  resetQueue,
  getBlueprints,
  blueprintAt,
  addBlueprint,
  reserve,
} from '../src/game/buildqueue';
import { updateGroups, resetGroups, groupIds, groupMembers } from '../src/game/groups';
import {
  ensureShelterProject,
  getShelterProject,
  resetShelters,
  type ShelterProject,
} from '../src/game/shelter';
import {
  updateCoopBuild,
  streamProject,
  shellComplete,
  queuedCellCount,
  clearGroupBuild,
} from '../src/game/coopbuild';

let failures = 0;
function check(cond: boolean, msg: string): void {
  console.log((cond ? 'PASS: ' : 'FAIL: ') + msg);
  if (!cond) failures++;
}

const FLOOR = 150;
const FEET = FLOOR - 1;

function resetWorld(): void {
  material.fill(AIR);
  integrity.fill(0);
  for (let x = 0; x < WORLD_W; x++) set(x, FLOOR, STONE);
  rebuildNavgrid();
  resetQueue();
  resetShelters();
  resetGroups();
  resetStockpile();
}

/** N survivors clustered tightly around column cx (so they form ONE group). */
function colony(cx: number, n: number): Survivor[] {
  const survs: Survivor[] = [];
  for (let i = 0; i < n; i++) survs.push(createSurvivor(cx - n + i * 2, FEET));
  return survs;
}

/** Make survivor i a hammer-bearing builder (bypasses crafting). */
function asBuilder(s: Survivor): Survivor {
  s.role = 'builder';
  s.tool = makeTool('hammer');
  s.roleState = 'toTarget';
  return s;
}

/** One sim tick: needs topped up so no override pulls a builder off the job. */
function tick(survs: Survivor[]): void {
  for (const s of survs) {
    s.needs.hunger = NEED_MAX;
    s.needs.thirst = NEED_MAX;
    s.needs.warmth = NEED_MAX;
  }
  for (const s of survs) updateSurvivor(s, []);
}

/** Count project cells not yet their target material. */
function unbuilt(p: ShelterProject): number {
  let n = 0;
  for (const c of p.cells) if (get(c.x, c.y) !== (c.kind === 'wall' ? WALL : WOOD)) n++;
  return n;
}

// ===========================================================================
// 1. STREAM + CAP - updateCoopBuild queues a co-located group's project, capped.
// ===========================================================================
{
  resetWorld();
  const survs = colony(400, 4);
  // Settle the group: co-located survivors adopt ONE group on first recompute.
  updateGroups(survs, 0);
  check(groupIds().length === 1, '1: four co-located survivors form a single group');
  const g = groupIds()[0];

  updateCoopBuild(survs);
  const project = getShelterProject(g);
  check(project !== null, '1: updateCoopBuild ensured the group a shelter project');
  const queued = getBlueprints().length;
  check(
    queued > 0 && queued <= MAX_BUILD_CLAIMS,
    `1: streamed cells are capped at MAX_BUILD_CLAIMS (${queued} in [1, ${MAX_BUILD_CLAIMS}])`,
  );
  check(
    queuedCellCount(project!) === queued,
    '1: every queued blueprint belongs to this project',
  );
  // Bottom-up: nothing queued sits above (smaller y than) an unqueued lower cell.
  const ys = getBlueprints().map((b) => b.y);
  const minQueuedY = Math.min(...ys);
  const anyLowerUnqueued = project!.cells.some(
    (c) => c.y > minQueuedY && blueprintAt(c.x, c.y) === null && get(c.x, c.y) !== (c.kind === 'wall' ? WALL : WOOD),
  );
  check(!anyLowerUnqueued, '1: streaming is bottom-up (no lower cell skipped for a higher one)');

  // Idempotent top-up: a second sync with the pool full adds nothing.
  updateCoopBuild(survs);
  check(getBlueprints().length === queued, '1: a second sync does not exceed the cap');
}

// ===========================================================================
// 2. TOP-UP + DIVISION - builders claim distinct cells, build, pool refills.
// ===========================================================================
{
  resetWorld();
  addResource('stone', 200); // walls are STONE (streamed bottom-up first)
  addResource('wood', 200); // roof is WOOD; plenty for the whole hut
  const survs = colony(400, 3).map(asBuilder);
  updateGroups(survs, 0);
  const g = groupIds()[0];
  updateCoopBuild(survs);
  const project = getShelterProject(g)!;

  // Let builders claim; with >1 unreserved cell the reserve split gives each a
  // distinct job (no double-claim on the same cell).
  for (let i = 0; i < 8; i++) tick(survs);
  const claimedCells = survs.map((s) => s.buildTarget).filter((b) => b !== null);
  const distinct = new Set(claimedCells.map((b) => b!.x + ',' + b!.y));
  check(
    distinct.size === claimedCells.length,
    `2: no two builders claim the same cell (${claimedCells.length} claims, ${distinct.size} distinct)`,
  );
  check(claimedCells.length >= 2, '2: multiple builders build in parallel (claims >= 2)');

  // Drive a while, re-streaming each tick (T5 cadence). The reachable lower
  // course should get built and the remaining count must strictly drop.
  const before = unbuilt(project);
  for (let i = 0; i < 1500; i++) {
    tick(survs);
    updateCoopBuild(survs);
  }
  const after = unbuilt(project);
  check(after < before, `2: builders raised streamed shelter cells (unbuilt ${before} -> ${after})`);
  check(
    queuedCellCount(project) <= MAX_BUILD_CLAIMS,
    '2: the claim pool stayed capped while topping up',
  );
}

// ===========================================================================
// 3. CAMPFIRE ON ENCLOSE - queued only once the shell is complete.
// ===========================================================================
{
  resetWorld();
  const survs = colony(400, 3);
  updateGroups(survs, 0);
  const g = groupIds()[0];
  const project = ensureShelterProject(g, groupMembers(g), survs)!;

  // Shell still open -> stream must NOT queue a campfire.
  streamProject(project);
  check(
    blueprintAt(project.campfire.x, project.campfire.y) === null ||
      blueprintAt(project.campfire.x, project.campfire.y)!.kind !== 'campfire',
    '3: no campfire queued while the shell is incomplete',
  );

  // Force-complete the shell (simulate the builders finishing every cell).
  resetQueue();
  for (const c of project.cells) placeMaterial(c.x, c.y, c.kind === 'wall' ? WALL : WOOD);
  check(shellComplete(project), '3: shell reads complete once every cell is placed');

  streamProject(project);
  const fbp = blueprintAt(project.campfire.x, project.campfire.y);
  check(fbp !== null && fbp.kind === 'campfire', '3: a campfire blueprint is queued on enclose');
  check(
    getBlueprints().filter((b) => b.kind === 'campfire').length === 1,
    '3: exactly one campfire is queued',
  );
  // Idempotent: re-stream does not double-queue the hearth.
  streamProject(project);
  check(
    getBlueprints().filter((b) => b.kind === 'campfire').length === 1,
    '3: re-streaming does not duplicate the campfire',
  );

  // A builder lights it (CAMPFIRE placed); then stream is a no-op.
  addResource('wood', 50);
  const builder = asBuilder(createSurvivor(project.campfire.x + 3, FEET));
  for (let i = 0; i < 2000 && get(project.campfire.x, project.campfire.y) !== CAMPFIRE; i++) {
    tick([builder]);
  }
  check(
    get(project.campfire.x, project.campfire.y) === CAMPFIRE,
    '3: a builder placed the campfire inside the enclosed hut',
  );
}

// ===========================================================================
// 4. RELEASE ON DEATH - a dead builder frees its reserved claim.
// ===========================================================================
{
  resetWorld();
  addResource('wood', 20);
  // A single reachable floor-row fence so the builder definitely claims it.
  addBlueprint(420, FEET, 'fence');
  const builder = asBuilder(createSurvivor(410, FEET));
  for (let i = 0; i < 12; i++) tick([builder]);
  const claim = builder.buildTarget;
  check(claim !== null && claim.reserved, '4: builder holds a reserved claim');

  builder.body.alive = false; // killed mid-job (bypasses assignRole)
  tick([builder]); // dead guard runs -> releaseBuildClaim
  check(builder.buildTarget === null, '4: dead builder dropped its local handle');
  check(claim !== null && claim.reserved === false, '4: the claim was RELEASED (re-claimable)');
}

// ===========================================================================
// 5. ABANDON - clearGroupBuild cancels unreserved cells, keeps reserved ones.
// ===========================================================================
{
  resetWorld();
  const survs = colony(400, 2);
  updateGroups(survs, 0);
  const g = groupIds()[0];
  const project = ensureShelterProject(g, groupMembers(g), survs)!;
  streamProject(project); // queue some cells
  const queued = getBlueprints().slice();
  check(queued.length >= 2, '5: project streamed at least two cells to abandon-test');

  // Pretend a builder reserved the first queued cell.
  reserve(queued[0]);
  const keptX = queued[0].x;
  const keptY = queued[0].y;

  clearGroupBuild(g);
  check(
    blueprintAt(keptX, keptY) !== null,
    '5: a RESERVED cell survives abandon (left for its builder)',
  );
  const remaining = getBlueprints().filter((b) => b !== queued[0]).length;
  check(remaining === 0, '5: every UNRESERVED project cell was cancelled');
}

// ---------------------------------------------------------------------------
console.log(
  failures === 0
    ? '\nALL PASS\nSUMMARY: coopbuild streams a group project into the queue capped at MAX_BUILD_CLAIMS bottom-up, builders divide and raise the reachable cells, the hearth is queued only once the shell encloses, a dead builder releases its claim, and clearGroupBuild abandons only the unreserved cells.'
    : `\nFAILED: ${failures} check(s)`,
);
process.exit(failures === 0 ? 0 : 1);
