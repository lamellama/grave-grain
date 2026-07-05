declare const process: any;
/**
 * test/r9-flag.test.ts - Playtest R9 camp flag (game/camp.ts):
 *
 *   1. GATE - with NO flag planted, updateCoopBuild plans nothing and queues
 *      nothing, however long the colony stands around.
 *   2. SITE - planting the flag sites the group's shelter project AT the flag
 *      column (not the group centroid) and starts streaming cells.
 *   3. RELOCATE - moving the flag abandons the old project (unreserved queued
 *      cells cancelled, record dropped) and re-plans at the new flag site on
 *      the next updateCoopBuild pass.
 *   4. SNAP - plantCampFlagAt snaps an air tap DOWN to stand on the surface
 *      and a ground tap UP to the first open cell.
 *
 * Headless over the real groups/shelter/coopbuild/buildqueue modules; fake
 * survivor-shaped objects (the same pattern as vs3-t4-splitmerge). tsc -> node.
 */

import { WORLD_W } from '../src/config';
import { material, integrity, set } from '../src/engine/grid';
import { STONE, AIR } from '../src/engine/materials';
import { rebuildNavgrid } from '../src/engine/navgrid';
import { addResource, resetStockpile } from '../src/game/resources';
import { resetQueue, getBlueprints } from '../src/game/buildqueue';
import { resetGroups, updateGroups, groupIds } from '../src/game/groups';
import { getShelterProject, resetShelters } from '../src/game/shelter';
import { updateCoopBuild } from '../src/game/coopbuild';
import {
  resetCampFlag,
  setCampFlag,
  getCampFlag,
  getFlagVersion,
  plantCampFlagAt,
} from '../src/game/camp';

let failures = 0;
function check(cond: boolean, msg: string): void {
  console.log((cond ? 'PASS: ' : 'FAIL: ') + msg);
  if (!cond) failures++;
}

const FLOOR = 150;
const FEET = FLOOR - 1;

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
  resetCampFlag();
  addResource('wood', 999);
  addResource('stone', 999);
}

let simTick = 0;

// ===========================================================================
// 1. GATE - nothing is planned or queued before the flag exists.
// ===========================================================================
{
  resetWorld();
  const survs = [sv(300, FEET), sv(302, FEET), sv(304, FEET)];
  updateGroups(survs, simTick++);
  const g = groupIds()[0];
  for (let i = 0; i < 10; i++) updateCoopBuild(survs);
  check(getCampFlag() === null, '1: no flag at start (version 0)');
  check(getFlagVersion() === 0, '1: flag version is 0 before placement');
  check(getShelterProject(g) === null, '1: NO shelter project without the flag');
  check(getBlueprints().length === 0, '1: NOTHING queued without the flag');
}

// ===========================================================================
// 2. SITE - the project goes up at the flag, not at the group centroid.
// ===========================================================================
{
  resetWorld();
  const survs = [sv(300, FEET), sv(302, FEET), sv(304, FEET)];
  updateGroups(survs, simTick++);
  const g = groupIds()[0];

  // Flag well away from the colony (centroid ~302).
  plantCampFlagAt(500, FEET);
  check(getFlagVersion() === 1, '2: placement bumps the version');
  updateCoopBuild(survs);
  const project = getShelterProject(g);
  check(project !== null, '2: flag placed -> the group owns a project');
  if (project) {
    check(
      Math.abs(project.interior.x - 500) <= 2,
      `2: project sited AT the flag (interior x=${project.interior.x}, flag=500)`,
    );
    check(project.flagVersion === 1, '2: project stamped with the flag version');
    check(getBlueprints().length > 0, '2: cells are streaming into the queue');
  }
}

// ===========================================================================
// 3. RELOCATE - moving the flag abandons the old camp and re-plans anew.
// ===========================================================================
{
  resetWorld();
  const survs = [sv(300, FEET), sv(302, FEET), sv(304, FEET)];
  updateGroups(survs, simTick++);
  const g = groupIds()[0];

  plantCampFlagAt(400, FEET);
  updateCoopBuild(survs);
  const oldProject = getShelterProject(g)!;
  check(oldProject !== null && getBlueprints().length > 0, '3: first camp planned + streaming at x~400');

  // The player moves the flag across the map.
  plantCampFlagAt(700, FEET);
  updateCoopBuild(survs);
  const newProject = getShelterProject(g);
  check(newProject !== null && newProject !== oldProject, '3: flag move -> project REPLACED');
  if (newProject) {
    check(
      Math.abs(newProject.interior.x - 700) <= 2,
      `3: new project sited at the NEW flag (interior x=${newProject.interior.x})`,
    );
    check(newProject.flagVersion === 2, '3: new project carries the bumped version');
    // Every queued blueprint belongs to the NEW project - the old camp's
    // unreserved cells were cancelled by the reconcile.
    const newCells = new Set(newProject.cells.map((c) => c.x + ',' + c.y));
    const strays = getBlueprints().filter((b) => !newCells.has(b.x + ',' + b.y));
    check(strays.length === 0, `3: old camp's queued cells cancelled (${strays.length} strays left)`);
  }
}

// ===========================================================================
// 4. SNAP - air taps fall to the surface; ground taps rise out of it.
// ===========================================================================
{
  resetWorld();
  plantCampFlagAt(600, 20); // sky tap high above the floor
  check(
    getCampFlag()!.x === 600 && getCampFlag()!.y === FEET,
    `4: sky tap snaps DOWN to stand on the surface (y=${getCampFlag()!.y}, expected ${FEET})`,
  );
  plantCampFlagAt(610, FLOOR); // tap ON the stone floor row itself
  check(
    getCampFlag()!.x === 610 && getCampFlag()!.y === FEET,
    `4: ground tap snaps UP to the first open cell (y=${getCampFlag()!.y}, expected ${FEET})`,
  );
  // Raw setCampFlag clamps but never snaps (used by the snap internally).
  setCampFlag(-50, 9999);
  check(getCampFlag()!.x === 0 && getCampFlag()!.y === 239, '4: setCampFlag clamps to world bounds');
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
if (failures > 0) process.exit(1);
