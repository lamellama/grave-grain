declare const process: any;
/**
 * r11-children.test.ts - round 11 colony growth: "when there is a hut, and
 * more than one survivor, it should create children over time - smaller
 * sprites that quickly grow into normal survivors" (game/children.ts).
 *
 * Done-when:
 *   1. GATED - no hut => no births, ever; a hut with only ONE adult => no
 *      births either (CHILD_MIN_ADULTS).
 *   2. BIRTH - hut + 2 adults => exactly one child appears after
 *      CHILD_BIRTH_TICKS, at the hut hearth: child-flagged, HALF-SCALE rig
 *      (strictly shorter/narrower than an adult), refused a working role.
 *   3. LIVES - the child runs updateSurvivor ticks like anyone (stands on the
 *      hut floor, no crash, needs intact).
 *   4. GROWS - after CHILD_GROW_TICKS it swaps to the full adult rig in
 *      place, drops the child flag and becomes assignable.
 *   5. CAPPED - births pause at CHILD_CAP_PER_HUT x huts population.
 */

import {
  CHILD_BIRTH_TICKS,
  CHILD_GROW_TICKS,
  CHILD_CAP_PER_HUT,
} from '../src/config';
import { DIRT, STONE, AIR } from '../src/engine/materials';
import { material, integrity, set } from '../src/engine/grid';
import { rebuildNavgrid } from '../src/engine/navgrid';
import { setChunkingEnabled } from '../src/engine/chunks';
import { __setWeatherForTest } from '../src/engine/weather';
import { placePrefabAt, prefabCost, resetHuts, latestHut } from '../src/game/prefabs';
import { addResource, resetStockpile } from '../src/game/resources';
import {
  updateChildren,
  resetChildren,
  createChild,
  growUp,
} from '../src/game/children';
import { createSurvivor, updateSurvivor, assignRole } from '../src/characters/survivor';
import type { Survivor } from '../src/characters/survivor';
import type { Body } from '../src/characters/body';

let failures = 0;
function check(cond: boolean, msg: string): void {
  console.log((cond ? 'PASS: ' : 'FAIL: ') + msg);
  if (!cond) failures++;
}
const SURF = 140;
function clear(): void {
  material.fill(AIR);
  integrity.fill(0);
  for (let x = 0; x < 500; x++) {
    for (let y = SURF; y < SURF + 8; y++) set(x, y, DIRT);
    for (let y = SURF + 8; y < SURF + 12; y++) set(x, y, STONE);
  }
  rebuildNavgrid();
}
function rigHeight(b: Body): number {
  let top = Infinity;
  let bottom = -Infinity;
  for (const bone of b.rig) {
    for (const p of bone.pixels) {
      const dy = bone.offset.dy + p.dy;
      if (dy < top) top = dy;
      if (dy > bottom) bottom = dy;
    }
  }
  return bottom - top + 1;
}

setChunkingEnabled(false);
__setWeatherForTest('clear');

// ── 1. Gated on hut + adults ────────────────────────────────────────────────
console.log('--- 1: gated ---');
clear();
resetHuts();
resetChildren();
const adults: Survivor[] = [
  createSurvivor(100, SURF - 1),
  createSurvivor(104, SURF - 1),
];
let births = 0;
for (let t = 0; t < CHILD_BIRTH_TICKS * 2; t++) births += updateChildren(adults).length;
check(births === 0, '1: no hut -> no births ever');

resetStockpile();
const hc = prefabCost('hut');
addResource('wood', (hc.wood ?? 0) * 2);
addResource('stone', (hc.stone ?? 0) * 2);
check(placePrefabAt('hut', 100, SURF - 1), '1: hut placed for the family');
resetChildren();
const loner: Survivor[] = [createSurvivor(100, SURF - 1)];
births = 0;
for (let t = 0; t < CHILD_BIRTH_TICKS * 2; t++) births += updateChildren(loner).length;
check(births === 0, '1: one adult -> no births (needs more than one survivor)');

// ── 2. Birth at the hearth ──────────────────────────────────────────────────
console.log('--- 2: birth ---');
resetChildren();
const colony: Survivor[] = [
  createSurvivor(100, SURF - 1),
  createSurvivor(104, SURF - 1),
];
const adultHeight = rigHeight(colony[0].body);
let firstBirthTick = -1;
for (let t = 1; t <= CHILD_BIRTH_TICKS + 5 && firstBirthTick < 0; t++) {
  const born = updateChildren(colony);
  for (const kid of born) colony.push(kid);
  if (born.length > 0) firstBirthTick = t;
}
check(firstBirthTick === CHILD_BIRTH_TICKS, `2: one child born after CHILD_BIRTH_TICKS (tick ${firstBirthTick})`);
const kid = colony[2];
check(kid !== undefined && kid.child === true, '2: newborn is child-flagged');
const hut = latestHut();
check(
  !!hut && Math.round(kid.body.x) === hut.x,
  '2: born at the hut hearth column',
);
const kidHeight = rigHeight(kid.body);
check(
  kidHeight < adultHeight - 3,
  `2: child rig is a small sprite (${kidHeight} rows vs adult ${adultHeight})`,
);
check(!assignRole(kid, 'guard'), '2: a child is refused a working role');

// ── 3. A child lives like a survivor ────────────────────────────────────────
console.log('--- 3: child ticks ---');
for (let t = 0; t < 120; t++) updateSurvivor(kid, []);
check(kid.body.alive, '3: child alive after 120 live ticks');
check(Math.abs(Math.round(kid.body.y) - (SURF - 1)) <= 2, '3: child stands on the hut floor');

// ── 4. Growth ────────────────────────────────────────────────────────────────
console.log('--- 4: grows up ---');
// Tick the growth clock down (birth consumed nothing of it yet).
for (let t = 0; t < CHILD_GROW_TICKS + 2 && kid.child; t++) updateChildren(colony);
check(!kid.child, '4: child grew up after CHILD_GROW_TICKS');
check(rigHeight(kid.body) === adultHeight, '4: grown rig is the full adult figure');
addResource('wood', 10);
check(assignRole(kid, 'lumberjack'), '4: a grown child takes a working role');

// ── 5. Population ceiling ────────────────────────────────────────────────────
console.log('--- 5: capped ---');
resetChildren();
while (colony.filter((s) => s.body.alive && !s.turned).length < CHILD_CAP_PER_HUT) {
  colony.push(createSurvivor(110, SURF - 1));
}
births = 0;
for (let t = 0; t < CHILD_BIRTH_TICKS * 2; t++) births += updateChildren(colony).length;
check(births === 0, `5: no births at the ${CHILD_CAP_PER_HUT}-per-hut ceiling`);

// createChild/growUp round-trip sanity (exported unit surface).
const unit = createChild(200, SURF - 1);
check(rigHeight(unit.body) < adultHeight, '5: createChild builds the small rig');
growUp(unit);
check(rigHeight(unit.body) === adultHeight && !unit.child, '5: growUp swaps to the adult rig');

if (failures > 0) {
  console.error(`\nFAILED: ${failures} check(s)`);
  process.exit(1);
}
console.log(
  '\nSUMMARY: births are gated on a hut + two adults, arrive on the birth clock at the hearth as half-scale unassignable children, live as normal survivors, grow into full adults on the growth clock, and stop at the per-hut population ceiling. ALL PASS',
);
