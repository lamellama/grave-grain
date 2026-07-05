declare const process: any;
/**
 * r8-door.test.ts - playtest v0.10 round 8: zombie-proof DOOR (GDD 8/7.4).
 *
 * "If they do build a complete shelter, they will need zombie proof doors to
 * allow the survivors in and out." DOOR (id 18) is permeable to LIVING bodies
 * (they walk through as if it were open) and SOLID to the UNDEAD (body.undead
 * gates it in locomotion) - who must GNAW it down through the normal breaching
 * pass (DOOR_INTEGRITY per cell, between fence and wall).
 *
 * Done-when:
 *   1. LIVING PASS - a survivor walks straight through a closed door column.
 *   2. UNDEAD BLOCKED - a zombie driven at the same door never crosses while
 *      it stands.
 *   3. GNAW THROUGH - an ATTACKING zombie pressing the door chips it via
 *      resolveBreaching and eventually breaks through (a door buys time; it is
 *      not a bunker).
 *   4. SHELTER DOORWAY IS A DOOR - planShelter now fills the doorway with
 *      SHELTER_DOORWAY_HEIGHT 'door' cells; in the BUILT hut a survivor enters
 *      through the closed door and stands sheltered; a zombie on the same
 *      approach stays outside.
 *   5. WEATHER SEAL - pooled water does not leak through a closed door.
 *   6. COSTED PLACEMENT - placeStructure('door') spends DOOR_COST atomically
 *      and seeds DOOR_INTEGRITY.
 */

import {
  WORLD_W,
  P3_GROUND_Y,
  NEED_MAX,
  DOOR_INTEGRITY,
  DOOR_COST,
  SHELTER_DOORWAY_HEIGHT,
  BODY_H,
} from '../src/config';
import { STONE, WATER, DOOR, WALL, WOOD, AIR } from '../src/engine/materials';
import { material, integrity, set, get, getIntegrity, placeMaterial } from '../src/engine/grid';
import { rebuildNavgrid } from '../src/engine/navgrid';
import * as sim from '../src/engine/simulation';
import { __setWeatherForTest } from '../src/engine/weather';
import { createSurvivor, updateSurvivor, isSheltered } from '../src/characters/survivor';
import { createZombie } from '../src/characters/zombie';
import { updateBody } from '../src/characters/locomotion';
import { resolveBreaching } from '../src/game/breaching';
import { placeStructure, canPlace } from '../src/game/building';
import { planShelter } from '../src/game/shelter';
import { updateGroups, resetGroups, groupIds } from '../src/game/groups';
import { resetShelters } from '../src/game/shelter';
import { addResource, getStockpile, resetStockpile } from '../src/game/resources';

let failures = 0;
function check(cond: boolean, msg: string): void {
  console.log((cond ? 'PASS: ' : 'FAIL: ') + msg);
  if (!cond) failures++;
}

__setWeatherForTest('clear');
sim.setChunkingEnabled(false);

const FLOOR = P3_GROUND_Y;
const FEET = FLOOR - 1;

function flatWorld(): void {
  material.fill(AIR);
  integrity.fill(0);
  for (let x = 0; x < WORLD_W; x++) set(x, FLOOR, STONE);
  rebuildNavgrid();
  resetGroups();
  resetShelters();
  resetStockpile();
}

/** A full-height closed door column at x (tall enough to bar a whole body). */
function doorColumn(x: number): void {
  for (let y = FEET - (BODY_H + 1); y <= FEET; y++) placeMaterial(x, y, DOOR);
}

// ===========================================================================
// 1. LIVING PASS - survivor walks through the closed door.
// ===========================================================================
console.log('\n=== 1 the living walk through a closed door ===');
{
  flatWorld();
  doorColumn(250);
  const s = createSurvivor(242, FEET);
  s.body.moveDir = 1;
  for (let t = 0; t < 80; t++) {
    updateBody(s.body);
    s.body.moveDir = 1; // keep driving (no AI in this scene)
  }
  check(Math.round(s.body.x) > 253, `survivor crossed the door line (x=${Math.round(s.body.x)})`);
  check(get(250, FEET) === DOOR, 'door still standing (passing through does not consume it)');
}

// ===========================================================================
// 2. UNDEAD BLOCKED - a zombie cannot cross the same door.
// ===========================================================================
console.log('\n=== 2 the undead are barred ===');
{
  flatWorld();
  doorColumn(250);
  const z = createZombie(242, FEET);
  z.body.moveDir = 1;
  for (let t = 0; t < 300; t++) {
    updateBody(z.body);
    z.body.moveDir = 1;
  }
  check(Math.round(z.body.x) < 250, `zombie held at the door (x=${Math.round(z.body.x)})`);
  check(get(250, FEET) === DOOR, 'door intact (no breaching pass in this scene)');
}

// ===========================================================================
// 3. GNAW THROUGH - an attacking zombie chips the door down and gets in.
// ===========================================================================
console.log('\n=== 3 an attacking mob gnaws the door down (it buys time) ===');
{
  flatWorld();
  doorColumn(250);
  const z = createZombie(244, FEET);
  z.state = 'attack'; // pursuing prey beyond the door - the gnaw condition
  const int0 = getIntegrity(250, FEET);
  check(int0 === DOOR_INTEGRITY, `door seeded at DOOR_INTEGRITY (${int0})`);
  let through = -1;
  for (let t = 0; t < 60000 && through < 0; t++) {
    z.body.moveDir = 1;
    updateBody(z.body);
    resolveBreaching([z]);
    if (Math.round(z.body.x) > 253) through = t;
  }
  check(through >= 0, `zombie eventually gnawed through the door (tick ${through})`);
  check(through > 400, `...but the door BOUGHT TIME first (${through} ticks > 400)`);
}

// ===========================================================================
// 4. SHELTER DOORWAY IS A DOOR - built hut lets the living in, bars the dead.
// ===========================================================================
console.log('\n=== 4 the coop hut ships with a door: living in, undead out ===');
{
  flatWorld();
  const m0 = createSurvivor(330, FEET);
  const m1 = createSurvivor(332, FEET);
  updateGroups([m0, m1], 0);
  const project = planShelter(groupIds()[0], [0, 1], [m0, m1]);
  check(project !== null, 'project planned');
  if (project) {
    const doorCells = project.cells.filter(c => c.kind === 'door');
    check(
      doorCells.length === SHELTER_DOORWAY_HEIGHT,
      `doorway holds ${doorCells.length} door cells (== SHELTER_DOORWAY_HEIGHT ${SHELTER_DOORWAY_HEIGHT})`,
    );
    // Raise the hut instantly (this test proves the door, not the build).
    for (const c of project.cells) {
      placeMaterial(c.x, c.y, c.kind === 'wall' ? WALL : c.kind === 'door' ? DOOR : WOOD);
    }
    rebuildNavgrid();
    const rightWallX = Math.max(...project.cells.map(c => c.x));
    check(doorCells.every(c => c.x === rightWallX), 'door fills the right-wall doorway');

    // A survivor outside the door walks IN through it...
    const cold = createSurvivor(rightWallX + 6, FEET);
    for (let t = 0; t < 200; t++) {
      cold.body.moveDir = -1;
      updateBody(cold.body);
    }
    const sx = Math.round(cold.body.x);
    check(sx < rightWallX, `survivor entered through the closed door (x=${sx} < ${rightWallX})`);
    check(isSheltered(cold.body), 'and stands sheltered inside');

    // ...while a zombie on the same approach is held at the door.
    const z = createZombie(rightWallX + 6, FEET);
    for (let t = 0; t < 300; t++) {
      z.body.moveDir = -1;
      updateBody(z.body);
    }
    check(Math.round(z.body.x) > rightWallX, `zombie stays outside (x=${Math.round(z.body.x)})`);
  }
}

// ===========================================================================
// 5. WEATHER SEAL - pooled water does not leak through a closed door.
// ===========================================================================
console.log('\n=== 5 a closed door holds back water ===');
{
  flatWorld();
  doorColumn(250);
  // A retaining wall on the far side so the pool presses the door.
  for (let y = FEET - 6; y <= FEET; y++) set(240, y, STONE);
  for (let y = FEET - 4; y <= FEET; y++)
    for (let x = 241; x < 250; x++) set(x, y, WATER);
  for (let t = 0; t < 400; t++) sim.step();
  let leaked = 0;
  for (let y = 0; y < FLOOR; y++)
    for (let x = 251; x < 290; x++) if (get(x, y) === WATER) leaked++;
  check(leaked === 0, `no water leaked past the closed door (${leaked} cells)`);
}

// ===========================================================================
// 6. COSTED PLACEMENT - door placement spends wood and seeds integrity.
// ===========================================================================
console.log('\n=== 6 door placement is costed ===');
{
  flatWorld();
  check(!canPlace('door'), 'broke colony cannot afford a door');
  addResource('wood', 5);
  check(canPlace('door'), 'wood-stocked colony can');
  const ok = placeStructure(300, FEET, 'door');
  check(ok, 'door placed');
  check(get(300, FEET) === DOOR, 'cell holds DOOR');
  check(getIntegrity(300, FEET) === DOOR_INTEGRITY, 'integrity seeded');
  check(getStockpile().wood === 5 - (DOOR_COST.wood ?? 0), 'DOOR_COST spent atomically');
}

console.log('\n' + (failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'));
process.exit(failures === 0 ? 0 : 1);
