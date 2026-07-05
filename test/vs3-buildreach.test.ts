declare const process: any;
/**
 * vs3-buildreach.test.ts - VS-3 geometry pass: builder CONSTRUCTION reach
 * (BUILDER_REACH_UP) resolves the T3 RISK. Headless Node test over REAL modules.
 *
 * The T3 risk: the planned hut's roof sits SHELTER_WALL_HEIGHT-1 (=15) cells
 * above the interior feet row, but harvest reach is only BODY_H (=12) - so the
 * roof + top wall courses were unreachable and the hut could NEVER enclose
 * (roof-CENTRE cells, over interior air, had nothing to stand on at all).
 * The fix: builders place blueprint cells from the ground BELOW with a taller
 * construction reach (BUILDER_REACH_UP = SHELTER_WALL_HEIGHT), AI-only - no
 * sim rule, no grid semantics, harvest/consume reach untouched.
 *
 * Done-when:
 *   1. INVARIANT - BUILDER_REACH_UP >= SHELTER_WALL_HEIGHT - 1 (roof height
 *      above the feet row) and > BODY_H (it actually extends the old reach).
 *   2. FULL ENCLOSE (the un-blocked e2e) - a group of builders streamed via
 *      updateCoopBuild raises the ENTIRE hut: every project cell (upper wall
 *      courses AND roof-centre cells included) reaches its target material.
 *   3. CAMPFIRE ON ENCLOSE - after the shell completes, the campfire blueprint
 *      is queued and a builder lights it (CAMPFIRE on the interior floor).
 *   4. SHELTERED INTERIOR - a body standing at the project's interior cell is
 *      isSheltered() once the roof is on.
 *   5. HARVEST REACH UNCHANGED - the taller reach is builder-only: a forager
 *      still cannot harvest foliage SHELTER_WALL_HEIGHT-1 cells overhead.
 */

import {
  WORLD_W,
  BODY_H,
  NEED_MAX,
  BUILDER_REACH_UP,
  SHELTER_WALL_HEIGHT,
} from '../src/config';
import { STONE, AIR, WALL, WOOD, FOLIAGE, CAMPFIRE } from '../src/engine/materials';
import { material, integrity, set, get } from '../src/engine/grid';
import { rebuildNavgrid } from '../src/engine/navgrid';
import {
  createSurvivor,
  updateSurvivor,
  isSheltered,
  type Survivor,
} from '../src/characters/survivor';
import { makeTool } from '../src/game/roles';
import { addResource, resetStockpile } from '../src/game/resources';
import { resetQueue, getBlueprints } from '../src/game/buildqueue';
import { updateGroups, resetGroups, groupIds } from '../src/game/groups';
import { getShelterProject, resetShelters, type ShelterProject } from '../src/game/shelter';
import { updateCoopBuild, shellComplete } from '../src/game/coopbuild';

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

/** Make survivor a hammer-bearing builder (bypasses crafting). */
function asBuilder(s: Survivor): Survivor {
  s.role = 'builder';
  s.tool = makeTool('hammer');
  s.roleState = 'toTarget';
  return s;
}

let simTick = 0;

/** One coop tick: needs topped + hammer refreshed (this test proves REACH, not
 *  the durability economy), groups recomputed, project streamed, builders run. */
function tick(survs: Survivor[]): void {
  for (const s of survs) {
    s.needs.hunger = NEED_MAX;
    s.needs.thirst = NEED_MAX;
    s.needs.warmth = NEED_MAX;
    if (s.role === 'builder') {
      if (s.tool === null) s.tool = makeTool('hammer');
      s.tool.durability = 999;
    }
  }
  updateGroups(survs, simTick);
  updateCoopBuild(survs);
  for (const s of survs) updateSurvivor(s, []);
  simTick++;
}

/** Count project cells not yet their target material. */
function unbuilt(p: ShelterProject): number {
  let n = 0;
  for (const c of p.cells) if (get(c.x, c.y) !== (c.kind === 'wall' ? WALL : WOOD)) n++;
  return n;
}

// ===========================================================================
// 1. INVARIANT - the construction reach actually covers the planned hut.
// ===========================================================================
check(
  BUILDER_REACH_UP >= SHELTER_WALL_HEIGHT - 1,
  `1: BUILDER_REACH_UP (${BUILDER_REACH_UP}) >= roof height above feet (${SHELTER_WALL_HEIGHT - 1})`,
);
check(BUILDER_REACH_UP > BODY_H, `1: BUILDER_REACH_UP (${BUILDER_REACH_UP}) > BODY_H (${BODY_H})`);

// ===========================================================================
// 2+3+4. FULL ENCLOSE e2e - builders raise the whole hut, then light the hearth.
// ===========================================================================
{
  resetWorld();
  addResource('wood', 500);
  addResource('stone', 500);

  // Three co-located builders -> one group on the first recompute.
  const survs: Survivor[] = [];
  for (let i = 0; i < 3; i++) survs.push(asBuilder(createSurvivor(300 + i * 2, FEET)));
  updateGroups(survs, simTick);
  check(groupIds().length === 1, '2: three co-located builders form a single group');
  const g = groupIds()[0];
  updateCoopBuild(survs);
  const project = getShelterProject(g);
  check(project !== null, '2: the group owns a shelter project');

  if (project) {
    const total = project.cells.length;
    check(unbuilt(project) === total, `2: all ${total} project cells start unbuilt`);

    // The RISK claim was that the hut can NEVER fully enclose. Refute it.
    let encloseTick = -1;
    for (let t = 0; t < 60000; t++) {
      tick(survs);
      if (unbuilt(project) === 0) {
        encloseTick = t;
        break;
      }
    }
    console.log(
      `  enclose tick=${encloseTick} unbuilt=${unbuilt(project)}/${total} ` +
        `alive=${survs.filter(s => s.body.alive).length}/3`,
    );
    check(encloseTick >= 0, '2: hut FULLY encloses (every wall+roof cell built) - RISK resolved');
    check(shellComplete(project), '2: shellComplete(project) === true');

    // Roof-centre proof: the mid-span roof cell (over interior air) is built.
    const roofCells = project.cells.filter(c => c.kind === 'fence');
    const midRoof = roofCells[Math.floor(roofCells.length / 2)];
    check(
      get(midRoof.x, midRoof.y) === WOOD,
      `2: roof-CENTRE cell (${midRoof.x},${midRoof.y}) is WOOD (was the unreachable case)`,
    );

    // 3. Campfire follows the enclose: queued by streamProject, lit by a builder.
    let fireTick = -1;
    for (let t = 0; t < 20000; t++) {
      tick(survs);
      if (get(project.campfire.x, project.campfire.y) === CAMPFIRE) {
        fireTick = t;
        break;
      }
    }
    check(fireTick >= 0, `3: campfire lit on the interior floor after enclose (tick ${fireTick})`);
    check(
      getBlueprints().filter(bp => bp.kind === 'campfire').length === 0,
      '3: campfire blueprint consumed (not re-queued)',
    );

    // 4. The finished hut shelters a body standing at the interior cell.
    const probe = createSurvivor(project.interior.x, project.interior.y);
    check(isSheltered(probe.body), '4: interior cell isSheltered() once the roof is on');
  }
}

// ===========================================================================
// 5. HARVEST REACH UNCHANGED - builder-only; a forager can't reach foliage 15 up.
// ===========================================================================
{
  resetWorld();
  const s = createSurvivor(300, FEET);
  // Foliage floating SHELTER_WALL_HEIGHT-1 above the feet row: inside the
  // builder construction reach but OUTSIDE harvest reach (> BODY_H).
  const fy = FEET - (SHELTER_WALL_HEIGHT - 1);
  set(300, fy, FOLIAGE);
  s.role = 'forager';
  s.tool = makeTool('basket');
  s.roleState = 'toTarget';
  let harvested = false;
  for (let t = 0; t < 3000; t++) {
    s.needs.hunger = NEED_MAX;
    s.needs.thirst = NEED_MAX;
    s.needs.warmth = NEED_MAX;
    updateSurvivor(s, []);
    if (get(300, fy) === AIR) harvested = true;
  }
  check(
    !harvested,
    `5: forager did NOT harvest foliage ${SHELTER_WALL_HEIGHT - 1} cells up (harvest reach still BODY_H)`,
  );
}

console.log('\n' + (failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`));
if (failures > 0) process.exit(1);
