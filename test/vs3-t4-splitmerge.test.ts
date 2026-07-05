declare const process: any;
/**
 * vs3-t4-splitmerge.test.ts - VS-3 T4: split -> own shelter, merge -> abandon
 * redundant (coopbuild.ts reconcile, GDD 6.2/8). Headless, real modules.
 *
 * T4 semantics: group PROJECT ownership follows the live group ids.
 *   - SPLIT: a group that forks needs no special-case - the new group id gets
 *     its OWN project (own site, near its own centroid) on the next
 *     updateCoopBuild; the original id keeps its project untouched.
 *   - MERGE / EXTINCTION: a project whose owning group id is no longer active
 *     (absorbed by a merge, or all members dead/turned) is ABANDONED: its
 *     UNRESERVED queued cells are cancelled, its project record dropped.
 *     RESERVED cells stay for their builder (no cancel-out-from-under).
 *
 * Uses fake survivor-shaped objects (groups.ts/shelter.ts read body.x/y/alive
 * + turned only) - no builders needed: streaming queues blueprints either way.
 *
 * Done-when:
 *   1. SPLIT -> OWN SHELTER: one group splits into two; the forked group gets
 *      its own project sited near ITS members; the original keeps project A
 *      (same object, still streaming).
 *   2. MERGE -> ABANDON: the groups remerge; the absorbed id's project is
 *      dropped (getShelterProject null) and its unreserved queued cells leave
 *      the queue; the surviving id's project + queue are untouched.
 *   3. RESERVED SURVIVES: a reserved cell of the absorbed project stays queued
 *      (its builder finishes or releases it).
 *   4. EXTINCT GROUP: all members of a project-owning group die -> the project
 *      is abandoned the same way.
 */

import {
  WORLD_W,
  SPLIT_DEBOUNCE_TICKS,
  MERGE_DEBOUNCE_TICKS,
  GROUP_RECHECK_TICKS,
} from '../src/config';
import { material, integrity, set } from '../src/engine/grid';
import { STONE, AIR } from '../src/engine/materials';
import { rebuildNavgrid } from '../src/engine/navgrid';
import { addResource, resetStockpile } from '../src/game/resources';
import { resetQueue, getBlueprints, blueprintAt, reserve } from '../src/game/buildqueue';
import { resetGroups, updateGroups, groupIds } from '../src/game/groups';
import {
  getShelterProject,
  resetShelters,
  type ShelterProject,
} from '../src/game/shelter';
import { updateCoopBuild, queuedCellCount } from '../src/game/coopbuild';

let failures = 0;
function check(cond: boolean, msg: string): void {
  console.log((cond ? 'PASS: ' : 'FAIL: ') + msg);
  if (!cond) failures++;
}

const FLOOR = 150;
const FEET = 149;

/** Minimal survivor-shaped object groups.ts/shelter.ts understand. */
function sv(x: number, y: number, alive = true, turned = false): any {
  return { body: { x, y, alive }, turned };
}

function resetWorld(): void {
  material.fill(AIR);
  integrity.fill(0);
  for (let x = 0; x < WORLD_W; x++) set(x, FLOOR, STONE);
  rebuildNavgrid();
  resetQueue();
  resetShelters();
  resetGroups();
  resetStockpile();
  addResource('wood', 999);
  addResource('stone', 999);
}

let simTick = 0;
/** Advance grouping n ticks (debounce is measured in real ticks). */
function groupTicks(survs: any[], n: number): void {
  for (let i = 0; i < n; i++) updateGroups(survs, simTick++);
}

// ===========================================================================
// 1+2+3. SPLIT -> own shelter; MERGE -> abandon redundant; reserved survives.
// ===========================================================================
{
  resetWorld();
  // Four survivors clustered at x~300: one group (canonical id = min index 0).
  const survs = [sv(298, FEET), sv(300, FEET), sv(302, FEET), sv(304, FEET)];
  groupTicks(survs, 1);
  check(groupIds().length === 1, '1: four co-located survivors form ONE group');
  const gA = groupIds()[0];
  updateCoopBuild(survs);
  const projectA = getShelterProject(gA);
  check(projectA !== null, '1: the group owns project A');
  check(queuedCellCount(projectA!) > 0, '1: project A cells are streaming into the queue');

  // SPLIT: members 2+3 walk far away (out of sight); debounce forks the group.
  survs[2].body.x = 700;
  survs[3].body.x = 702;
  groupTicks(survs, SPLIT_DEBOUNCE_TICKS + 2 * GROUP_RECHECK_TICKS);
  check(groupIds().length === 2, `1: the group SPLITS into two (got ${groupIds().length})`);
  const gB = groupIds().find(g => g !== gA)!;
  updateCoopBuild(survs);
  const projectB = getShelterProject(gB);
  check(projectB !== null, '1: the forked group gets its OWN project B');
  check(getShelterProject(gA) === projectA, '1: the original group keeps project A (same object)');
  const bSite = projectB!.interior.x;
  check(
    Math.abs(bSite - 701) < 50 && Math.abs(bSite - 301) > 200,
    `1: project B is sited near ITS members (interior x=${bSite}, members at ~701)`,
  );
  check(queuedCellCount(projectB!) > 0, '1: project B cells are streaming into the queue');

  // 3-setup. Reserve ONE of project B's queued cells (a builder is "walking to it").
  const queuedB = projectB!.cells.filter(c => blueprintAt(c.x, c.y) !== null);
  const keep = blueprintAt(queuedB[0].x, queuedB[0].y)!;
  reserve(keep);

  // MERGE: members 2+3 walk back; debounce remerges into gA; gB vanishes.
  survs[2].body.x = 302;
  survs[3].body.x = 304;
  groupTicks(survs, MERGE_DEBOUNCE_TICKS + 2 * GROUP_RECHECK_TICKS);
  check(groupIds().length === 1 && groupIds()[0] === gA, '2: the groups REMERGE into the original id');

  updateCoopBuild(survs);
  check(getShelterProject(gB) === null, '2: absorbed group\'s project B is ABANDONED (record dropped)');
  check(getShelterProject(gA) === projectA, '2: surviving group still owns project A');
  check(queuedCellCount(projectA!) > 0, '2: project A keeps streaming');
  const bLeftQueued = projectB!.cells.filter(c => blueprintAt(c.x, c.y) !== null);
  check(
    bLeftQueued.length === 1 &&
      bLeftQueued[0].x === keep.x &&
      bLeftQueued[0].y === keep.y,
    `3: exactly the RESERVED B cell survives in the queue (${bLeftQueued.length} left)`,
  );
  check(blueprintAt(keep.x, keep.y)!.reserved === true, '3: the surviving cell is still reserved');
}

// ===========================================================================
// 4. EXTINCT GROUP - all members die -> project abandoned, queue cleaned.
// ===========================================================================
{
  resetWorld();
  simTick += GROUP_RECHECK_TICKS; // fresh recompute window
  const survs = [sv(400, FEET), sv(402, FEET)];
  groupTicks(survs, 1);
  const g = groupIds()[0];
  updateCoopBuild(survs);
  const project = getShelterProject(g);
  check(project !== null && queuedCellCount(project!) > 0, '4: live group owns a streaming project');

  survs[0].body.alive = false;
  survs[1].body.alive = false;
  groupTicks(survs, 2 * GROUP_RECHECK_TICKS);
  check(groupIds().length === 0, '4: dead members leave NO active groups');
  updateCoopBuild(survs);
  check(getShelterProject(g) === null, '4: the extinct group\'s project is abandoned');
  check(getBlueprints().length === 0, '4: its queued (unreserved) cells are all cancelled');
}

console.log('\n' + (failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`));
if (failures > 0) process.exit(1);
