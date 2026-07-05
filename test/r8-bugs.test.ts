declare const process: any;
/**
 * r8-bugs.test.ts - playtest v0.10 round 8, bug fixes (GDD 12.2/8/6.2).
 *
 * Done-when:
 *   1. DROWN ATTRIBUTION - a survivor that drowns is logged as 'drowned' in the
 *      death log (was: 'killed by zombies', because the kill resolves inside
 *      locomotion and never set survivor.deathCause). A cause-less kill (real
 *      zombie dissolve) still falls back to 'killed by zombies'.
 *   2. SHELTER ON THE GROUND - a group standing UNDER a pre-existing roof (the
 *      starter camp) plans its hut on the ground beneath its feet, NOT on top
 *      of the roof the sky sees first (the "floating shelter" bug).
 *   3. NO PHANTOM WOOD - a lumberjack in a world with ZERO foliage never
 *      deposits wood (pins the harvest gate; "wood without trees" in the
 *      playtest is off-screen/buried foliage within RESOURCE_SCAN_RADIUS, not
 *      conjured wood).
 */

import { WORLD_W, P3_GROUND_Y, NEED_MAX, DROWN_TICKS, SHELTER_WALL_HEIGHT } from '../src/config';
import { STONE, WATER, WOOD, AIR } from '../src/engine/materials';
import { material, integrity, set, get } from '../src/engine/grid';
import { rebuildNavgrid } from '../src/engine/navgrid';
import { createSurvivor, updateSurvivor } from '../src/characters/survivor';
import { applyDamage } from '../src/characters/damage';
import { makeTool } from '../src/game/roles';
import { createGameState, updateGameState } from '../src/game/state';
import { createWaveState } from '../src/game/waves';
import { updateGroups, resetGroups, groupIds } from '../src/game/groups';
import { planShelter } from '../src/game/shelter';
import {
  resetStockpile,
  getStockpile,
  setStockpilePoint,
} from '../src/game/resources';
import { __setWeatherForTest } from '../src/engine/weather';

let failures = 0;
function check(cond: boolean, msg: string): void {
  console.log((cond ? 'PASS: ' : 'FAIL: ') + msg);
  if (!cond) failures++;
}

__setWeatherForTest('clear'); // no ambient interference with the scenes

const FLOOR = P3_GROUND_Y;
const FEET = FLOOR - 1;

function flatWorld(): void {
  material.fill(AIR);
  integrity.fill(0);
  for (let x = 0; x < WORLD_W; x++) set(x, FLOOR, STONE);
  rebuildNavgrid();
  resetGroups();
  resetStockpile();
}

// ===========================================================================
// 1. DROWN ATTRIBUTION through the real state watcher.
// ===========================================================================
console.log('\n=== 1 drowned survivor is logged as drowned ===');
{
  flatWorld();
  // Sealed flooded box (no air pocket): the buoyant survivor cannot rise clear.
  const BX0 = 200;
  const BX1 = 214;
  const CEIL = FLOOR - 15;
  for (let x = BX0 - 1; x <= BX1 + 1; x++) set(x, CEIL, STONE);
  for (let y = CEIL; y <= FLOOR; y++) {
    set(BX0 - 1, y, STONE);
    set(BX1 + 1, y, STONE);
  }
  for (let y = CEIL + 1; y < FLOOR; y++)
    for (let x = BX0; x <= BX1; x++) set(x, y, WATER);

  const s = createSurvivor(207, FEET);
  const state = createGameState();
  const waveState = createWaveState();
  for (let t = 0; t < DROWN_TICKS + 30 && state.deathLog.length === 0; t++) {
    s.needs.hunger = NEED_MAX;
    s.needs.thirst = NEED_MAX;
    s.needs.warmth = NEED_MAX;
    updateSurvivor(s, []);
    updateGameState(state, { survivors: [s], waveState, aliveZombieCount: 0, tick: t });
  }
  check(!s.body.alive, 'setup: the sealed-box survivor drowned');
  check(state.deathLog.length === 1, 'exactly one death logged');
  const cause = state.deathLog[0]?.cause ?? '(none)';
  check(cause === 'drowned', `death cause is 'drowned' (got '${cause}')`);
  check(state.status === 'lost' && (state.result ?? '').includes('drowned'),
    `lose banner carries the real cause (got '${state.result}')`);
}

console.log('\n=== 1b cause-less kill still reads as zombies ===');
{
  flatWorld();
  const s = createSurvivor(300, FEET);
  const state = createGameState();
  const waveState = createWaveState();
  // Register alive, then dissolve the head (the zombie-kill path, no cause set).
  updateGameState(state, { survivors: [s], waveState, aliveZombieCount: 0, tick: 0 });
  applyDamage(s.body, 'head');
  updateGameState(state, { survivors: [s], waveState, aliveZombieCount: 0, tick: 1 });
  const cause = state.deathLog[0]?.cause ?? '(none)';
  check(cause === 'killed by zombies', `fallback preserved (got '${cause}')`);
}

// ===========================================================================
// 2. SHELTER PLANNED ON THE GROUND under a pre-existing roof.
// ===========================================================================
console.log('\n=== 2 hut sites on the ground, not the starter-camp roof ===');
{
  flatWorld();
  // A "starter camp" roof over the spawn: a WOOD span well above their heads.
  const ROOF = FEET - 14;
  for (let x = 290; x <= 315; x++) set(x, ROOF, WOOD);

  const a = createSurvivor(300, FEET);
  const b = createSurvivor(303, FEET);
  updateGroups([a, b], 0);
  check(groupIds().length === 1, 'setup: the pair forms one group under the roof');

  const project = planShelter(groupIds()[0], [0, 1], [a, b]);
  check(project !== null, 'a shelter project plans');
  if (project) {
    check(
      project.interior.y === FEET,
      `hut interior feet row is the GROUND row (${project.interior.y} === ${FEET}, not above the roof)`,
    );
    const roofRow = FEET - (SHELTER_WALL_HEIGHT - 1);
    const projectRoofRows = project.cells.filter(c => c.kind === 'fence').map(c => c.y);
    check(
      projectRoofRows.every(y => y === roofRow),
      `planned roof sits ${SHELTER_WALL_HEIGHT - 1} above the GROUND feet row (row ${projectRoofRows[0]})`,
    );
  }
}

// ===========================================================================
// 3. NO PHANTOM WOOD - zero foliage means zero wood, forever.
// ===========================================================================
console.log('\n=== 3 lumberjack with no trees never deposits wood ===');
{
  flatWorld(); // note: NO foliage anywhere in this world
  setStockpilePoint(310, FEET);
  const s = createSurvivor(300, FEET);
  s.role = 'lumberjack';
  s.tool = makeTool('axe');
  s.roleState = 'toTarget';
  for (let t = 0; t < 2000; t++) {
    s.needs.hunger = NEED_MAX;
    s.needs.thirst = NEED_MAX;
    s.needs.warmth = NEED_MAX;
    if (s.tool) s.tool.durability = 999;
    updateSurvivor(s, []);
  }
  check(getStockpile().wood === 0, `stockpile wood stayed 0 (got ${getStockpile().wood})`);
  check(s.carrying === 0, 'lumberjack is carrying nothing');
  check(s.body.alive, 'and is still alive (just idling)');
}

console.log('\n' + (failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'));
process.exit(failures === 0 ? 0 : 1);
