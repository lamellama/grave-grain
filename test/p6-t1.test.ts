/**
 * Headless verification for p6-t1 (foliage permeability — GDD §9, §5.2).
 * Imports the REAL modules (no mocks). Seeds terrain directly into grid.material.
 * Run via tsc (commonjs) -> node.
 *
 * Covers Done-when #1 (isSolidForBody truth table), #2 (walk THROUGH a foliage
 * column on a stone floor with no tunnel into stone), #3 (fall through foliage-
 * only support), and #4's navgrid half (a survivor paths across a floor+foliage
 * scene because foliage doesn't block routing).
 */
import { createBody, type Body } from '../src/characters/body';
import { updateBody } from '../src/characters/locomotion';
import { material, idx, get } from '../src/engine/grid';
import {
  isSolidForBody,
  AIR,
  SAND,
  STONE,
  WATER,
  DIRT,
  ORE,
  WOOD,
  FOLIAGE,
  FIRE,
  SMOKE,
  ASH,
  FLESH,
  BONE,
  BLOOD,
} from '../src/engine/materials';
import { WORLD_W, WORLD_H } from '../src/config';
import { rebuildNavgrid } from '../src/engine/navgrid';
import { findPath } from '../src/game/pathfinding';

let failures = 0;
function check(cond: boolean, msg: string): void {
  console.log((cond ? 'PASS ' : 'FAIL ') + msg);
  if (!cond) failures++;
}

function fillCol(x: number, fromRow: number): void {
  for (let r = fromRow; r < WORLD_H; r++) material[idx(x, r)] = STONE;
}

// Lowest non-destroyed pixel world-row of the body (the feet contact row).
function lowestPixelRow(body: Body): number {
  const ry = Math.round(body.y);
  let lowest = -Infinity;
  for (const bone of body.rig) {
    if (bone.destroyed) continue;
    for (const p of bone.pixels) lowest = Math.max(lowest, ry + bone.offset.dy + p.dy);
  }
  return lowest;
}

// True if ANY body pixel currently overlaps a STONE cell (no-tunnel breach).
function overlapsStone(body: Body): boolean {
  const rx = Math.round(body.x);
  const ry = Math.round(body.y);
  for (const bone of body.rig) {
    if (bone.destroyed) continue;
    for (const p of bone.pixels) {
      if (get(rx + bone.offset.dx + p.dx, ry + bone.offset.dy + p.dy) === STONE) return true;
    }
  }
  return false;
}

// ===========================================================================
// 1. isSolidForBody truth table (Done-when #1)
// ===========================================================================
console.log('--- Done-when #1: isSolidForBody truth table ---');
check(isSolidForBody(FOLIAGE) === false, 'FOLIAGE non-solid for bodies');
for (const [name, id] of [
  ['SAND', SAND], ['STONE', STONE], ['DIRT', DIRT], ['ORE', ORE],
  ['WOOD', WOOD], ['ASH', ASH], ['FLESH', FLESH], ['BONE', BONE],
] as Array<[string, number]>) {
  check(isSolidForBody(id) === true, `${name} solid for bodies`);
}
for (const [name, id] of [
  ['AIR', AIR], ['WATER', WATER], ['FIRE', FIRE], ['SMOKE', SMOKE], ['BLOOD', BLOOD],
] as Array<[string, number]>) {
  check(isSolidForBody(id) === false, `${name} non-solid for bodies`);
}
// Out-of-range ids stay solid (fail safe).
check(isSolidForBody(-1) === true && isSolidForBody(999) === true, 'out-of-range ids solid (fail safe)');

// ===========================================================================
// 2. Walk THROUGH a foliage column on a stone floor; never tunnel stone (#2)
// ===========================================================================
console.log('\n--- Done-when #2: walk through foliage column on a stone floor ---');
const FLOOR = 220;
material.fill(AIR);
for (let x = 0; x < WORLD_W; x++) fillCol(x, FLOOR); // flat stone floor

// A foliage column standing in the walking lane, taller than the body so it
// genuinely covers every body pixel as it passes (proves pass-through).
const FOL_X0 = 120;
const FOL_X1 = 122; // 3-cell-wide
for (let x = FOL_X0; x <= FOL_X1; x++) {
  for (let y = FLOOR - 16; y < FLOOR; y++) material[idx(x, y)] = FOLIAGE;
}

const body: Body = createBody(60, 100);
for (let t = 0; t < 80; t++) updateBody(body); // settle onto the floor
const startX = Math.round(body.x);
check(body.grounded && lowestPixelRow(body) === FLOOR - 1, `body grounded on stone floor (start x=${startX})`);

let tunneled = false;
body.moveDir = 1;
for (let t = 0; t < 800; t++) {
  updateBody(body);
  if (overlapsStone(body)) tunneled = true;
  if (Math.round(body.x) > FOL_X1 + 10) break; // walked well past the column
}
const endX = Math.round(body.x);
check(endX > FOL_X1, `body advanced PAST foliage column: start x=${startX} -> end x=${endX} (column x=${FOL_X0}..${FOL_X1})`);
check(lowestPixelRow(body) === FLOOR - 1, `body still held up by stone floor after passing through (lowest=${lowestPixelRow(body)}, floor top=${FLOOR})`);
check(!tunneled, 'NO body pixel ever occupied a STONE cell while passing foliage');

// ===========================================================================
// 3. ONLY foliage beneath the body -> it FALLS through (#3)
// ===========================================================================
console.log('\n--- Done-when #3: foliage-only support -> falls through ---');
material.fill(AIR);
const FOL_FLOOR = 120; // a "platform" made of foliage (3 cells thick)
for (let x = 0; x < WORLD_W; x++) {
  for (let y = FOL_FLOOR; y < FOL_FLOOR + 3; y++) material[idx(x, y)] = FOLIAGE;
}
// A real stone catch-floor far below so the body stops eventually (proves it
// fell THROUGH the foliage to the stone, not rested on the foliage).
const CATCH = 200;
for (let x = 0; x < WORLD_W; x++) fillCol(x, CATCH);

const faller: Body = createBody(80, 70);
const yFallStart = Math.round(faller.y);
let restedRow = -1;
for (let t = 0; t < 2000; t++) {
  updateBody(faller);
  if (faller.grounded) { restedRow = lowestPixelRow(faller); break; }
}
check(restedRow === CATCH - 1, `body fell THROUGH foliage (start y=${yFallStart}, foliage rows ${FOL_FLOOR}..${FOL_FLOOR + 2}) and rested on stone catch floor (lowest=${restedRow}, expected ${CATCH - 1})`);

// ===========================================================================
// 4. Navgrid: a survivor paths across a floor+foliage scene (foliage doesn't
//    block routing). (Done-when #4 navgrid half)
// ===========================================================================
console.log('\n--- Done-when #4: navgrid routes across floor with foliage bushes ---');
material.fill(AIR);
const NF = 200;
for (let x = 0; x < WORLD_W; x++) fillCol(x, NF); // flat stone floor
// Two foliage bushes sitting on the floor, in the path's lane.
for (let x = 100; x <= 105; x++) for (let y = NF - 6; y < NF; y++) material[idx(x, y)] = FOLIAGE;
for (let x = 160; x <= 165; x++) for (let y = NF - 6; y < NF; y++) material[idx(x, y)] = FOLIAGE;
rebuildNavgrid();
const path = findPath(40, NF - 1, 240, NF - 1);
check(path !== null && path.waypoints.length > 0, `path found across floor through/under foliage bushes (waypoints=${path ? path.waypoints.length : 0})`);

console.log('\n' + (failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`));
if (failures > 0) throw new Error(`${failures} failure(s)`);
