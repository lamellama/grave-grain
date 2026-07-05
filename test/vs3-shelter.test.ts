/**
 * Headless verification for VS-3 T2 - per-group shelter PROJECT planning
 * (shelter.ts, GDD 8/6.1). Real modules. Run via tsc (commonjs) -> node.
 *
 * Covers:
 *   1. Sized by member count (interior area >= members*PER_SURVIVOR_AREA and
 *      >= MIN_SIZE; more members -> bigger hut).
 *   2. Sited near the group centroid.
 *   3. Geometry: a WOOD roof spanning the width, a full LEFT wall, and a RIGHT
 *      wall with a DOORWAY gap (not sealed).
 *   4. Enclosure satisfies VS-2's shelter test: build the cells -> a body on the
 *      interior floor isSheltered; a spot with no roof is not.
 *   5. One project per group (ensure is idempotent; clear removes).
 *   6. Deterministic (same inputs -> same cells).
 */
import {
  WORLD_W,
  SHELTER_PER_SURVIVOR_AREA,
  SHELTER_MIN_SIZE,
  SHELTER_DOORWAY_HEIGHT,
} from '../src/config';
import { STONE, AIR, WALL, WOOD, DOOR } from '../src/engine/materials';
import { material, set, placeMaterial } from '../src/engine/grid';
import { createSurvivor, isShelteredAt, type Survivor } from '../src/characters/survivor';
import {
  planShelter,
  ensureShelterProject,
  getShelterProject,
  clearShelterProject,
  resetShelters,
  type ShelterProject,
} from '../src/game/shelter';

let failures = 0;
function check(cond: boolean, msg: string): void {
  console.log((cond ? 'PASS: ' : 'FAIL: ') + msg);
  if (!cond) failures++;
}
function clearGrid(): void {
  material.fill(AIR);
}
const FLOOR = 150;
function floor(): void {
  for (let x = 0; x < WORLD_W; x++) set(x, FLOOR, STONE);
}
/** N survivors clustered around centre column `cx`. */
function colony(cx: number, n: number): Survivor[] {
  const survs: Survivor[] = [];
  for (let i = 0; i < n; i++) survs.push(createSurvivor(cx - n + i * 2, FLOOR - 1));
  return survs;
}

// ===========================================================================
// 1 + 2. Sizing by member count + centroid siting.
// ===========================================================================
clearGrid();
floor();
resetShelters();
{
  const small = colony(400, 2);
  const big = colony(400, 12);
  const ps = planShelter(0, [0, 1], small) as ShelterProject;
  const pb = planShelter(1, big.map((_, i) => i), big) as ShelterProject;
  check(ps !== null && pb !== null, '1: planShelter returns a project on flat ground');

  const wantSmall = Math.max(SHELTER_MIN_SIZE, 2 * SHELTER_PER_SURVIVOR_AREA);
  const wantBig = Math.max(SHELTER_MIN_SIZE, 12 * SHELTER_PER_SURVIVOR_AREA);
  check(ps.area >= wantSmall, `1: 2-member hut area ${ps.area} >= target ${wantSmall}`);
  check(pb.area >= wantBig, `1: 12-member hut area ${pb.area} >= target ${wantBig}`);
  check(pb.iw > ps.iw, `1: more members -> wider hut (iw ${pb.iw} > ${ps.iw})`);

  // Centroid: interior x sits near the colony's average column (~400).
  check(Math.abs(ps.interior.x - 400) <= ps.iw, `2: hut sited near the group centroid (interior x=${ps.interior.x})`);
}

// ===========================================================================
// 3. Geometry - roof span, full left wall, right-wall doorway gap.
// ===========================================================================
{
  const survs = colony(400, 4);
  const p = planShelter(0, [0, 1, 2, 3], survs) as ShelterProject;
  const xs = p.cells.map((c) => c.x);
  const ys = p.cells.map((c) => c.y);
  const leftX = Math.min(...xs);
  const rightX = Math.max(...xs);
  const roofRow = Math.min(...ys);
  const feetRow = Math.max(...ys);

  const roof = p.cells.filter((c) => c.y === roofRow && c.kind === 'fence');
  check(roof.length === rightX - leftX + 1, '3: WOOD roof spans the full hut width');

  const leftWall = p.cells.filter((c) => c.x === leftX && c.kind === 'wall');
  const rightWall = p.cells.filter((c) => c.x === rightX && c.kind === 'wall');
  check(leftWall.length === feetRow - roofRow, '3: left wall is full height');
  check(
    rightWall.length > 0 && rightWall.length < leftWall.length,
    `3: right wall has a DOORWAY gap (right ${rightWall.length} < left ${leftWall.length})`,
  );
  // The doorway is the bottom of the right column - since v0.10 (playtest R8)
  // it is filled with DOOR cells: permeable to the LIVING (they walk through
  // exactly as before) but a barred, gnawable structure to the UNDEAD.
  const rightDoor = p.cells.filter((c) => c.x === rightX && c.kind === 'door');
  check(
    rightDoor.length === SHELTER_DOORWAY_HEIGHT,
    '3: doorway holds ' + rightDoor.length + ' DOOR cells (== SHELTER_DOORWAY_HEIGHT)',
  );
  check(rightDoor.some((c) => c.y === feetRow), '3: the door reaches the floor');
}

// ===========================================================================
// 4. Built enclosure satisfies isSheltered (VS-2 shelter test).
// ===========================================================================
{
  clearGrid();
  floor();
  const survs = colony(400, 4);
  const p = planShelter(0, [0, 1, 2, 3], survs) as ShelterProject;
  // Build the blueprint: 'wall' -> WALL, 'fence' -> WOOD.
  for (const c of p.cells) placeMaterial(c.x, c.y, c.kind === 'wall' ? WALL : c.kind === 'door' ? DOOR : WOOD);

  check(
    isShelteredAt(p.interior.x, p.interior.y) === true,
    '4: a body on the interior floor is SHELTERED once the hut is built',
  );
  // A spot far away (no roof) is NOT sheltered.
  check(
    isShelteredAt(50, FLOOR - 1) === false,
    '4: open ground with no roof is NOT sheltered',
  );
}

// ===========================================================================
// 5. One project per group (ensure idempotent; clear removes).
// ===========================================================================
{
  clearGrid();
  floor();
  resetShelters();
  const survs = colony(600, 3);
  const a = ensureShelterProject(7, [0, 1, 2], survs);
  const b = ensureShelterProject(7, [0, 1, 2], survs);
  check(a !== null && a === b, '5: ensureShelterProject returns the SAME project for a group');
  check(getShelterProject(7) === a, '5: getShelterProject returns the owned project');
  clearShelterProject(7);
  check(getShelterProject(7) === null, '5: clearShelterProject abandons it');
}

// ===========================================================================
// 6. Determinism - same inputs produce identical cells.
// ===========================================================================
{
  clearGrid();
  floor();
  const survs = colony(800, 5);
  const idx = [0, 1, 2, 3, 4];
  const p1 = planShelter(2, idx, survs) as ShelterProject;
  const p2 = planShelter(2, idx, survs) as ShelterProject;
  const same =
    p1.cells.length === p2.cells.length &&
    p1.cells.every((c, i) => c.x === p2.cells[i].x && c.y === p2.cells[i].y && c.kind === p2.cells[i].kind);
  check(same, '6: planShelter is deterministic (identical cells for identical inputs)');
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
if (failures > 0) throw new Error('vs3-shelter assertions failed');
console.log(
  'SUMMARY: per-group shelter projects are sized by member count, sited at the group centroid, form a roofed hut with a full left wall + a doorway, satisfy isSheltered once built, are one-per-group, and plan deterministically.',
);
