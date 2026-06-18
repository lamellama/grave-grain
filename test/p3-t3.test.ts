/**
 * Headless verification for p3-t3 (characters/locomotion.ts horizontal walk).
 * Imports the REAL modules (no mocks). Seeds terrain directly into grid.material.
 * Run via tsc (commonjs) -> node.
 *
 * Terrain strip (left->right): flat ground, a 1-cell step up, more flat ground,
 * a 3-cell-tall wall, then a pit. Checks: climb the step, stop at the wall,
 * fall into the pit when the wall is removed, and the no-tunnel invariant.
 */
import { createBody, type Body } from '../src/characters/body';
import { updateBody } from '../src/characters/locomotion';
import { material, idx, get } from '../src/engine/grid';
import { isSolidForBody, STONE, AIR } from '../src/engine/materials';
import { WORLD_W, WORLD_H } from '../src/config';

function fail(msg: string): never {
  console.log('FAIL:', msg);
  throw new Error(msg);
}

// Lowest non-destroyed pixel world-row of the body (the feet contact row).
function lowestPixelRow(body: Body): number {
  const ry = Math.round(body.y);
  let lowest = -Infinity;
  for (const bone of body.rig) {
    if (bone.destroyed) continue;
    for (const p of bone.pixels) {
      lowest = Math.max(lowest, ry + bone.offset.dy + p.dy);
    }
  }
  return lowest;
}

// Rightmost non-destroyed pixel column among pixels at/below `row` (i.e. the
// pixels that can actually collide with a wall whose solid top is `row`).
// (Upper pixels like the arms harmlessly overhang ABOVE a wall's top.)
function rightmostColAtOrBelow(body: Body, row: number): number {
  const rx = Math.round(body.x);
  const ry = Math.round(body.y);
  let right = -Infinity;
  for (const bone of body.rig) {
    if (bone.destroyed) continue;
    for (const p of bone.pixels) {
      if (ry + bone.offset.dy + p.dy >= row) {
        right = Math.max(right, rx + bone.offset.dx + p.dx);
      }
    }
  }
  return right;
}

// Assert NO body pixel currently sits in a solid cell (no-tunnel invariant).
function assertNoOverlap(body: Body, tick: number, scenario: string): void {
  const rx = Math.round(body.x);
  const ry = Math.round(body.y);
  for (const bone of body.rig) {
    if (bone.destroyed) continue;
    for (const p of bone.pixels) {
      const wx = rx + bone.offset.dx + p.dx;
      const wy = ry + bone.offset.dy + p.dy;
      if (isSolidForBody(get(wx, wy))) {
        fail(`${scenario}: pixel overlapped solid at (${wx},${wy}) on tick ${tick}`);
      }
    }
  }
}

function fillCol(x: number, fromRow: number): void {
  for (let r = fromRow; r < WORLD_H; r++) material[idx(x, r)] = STONE;
}

// ---------------------------------------------------------------------------
// Terrain A (with wall): low flat (220), 1-cell step up to 219, raised flat,
// a 3-cell wall (top 216) at x=200..209, then a pit beyond.
// ---------------------------------------------------------------------------
const LOW = 220; // low floor top row
const HIGH = LOW - 1; // raised floor top row (219) — exactly 1 cell higher
const WALL_X = 200; // first wall column
const WALL_TOP = HIGH - 3; // wall top row (216) — 3 cells above the raised floor

function buildTerrainWithWall(): void {
  material.fill(AIR);
  for (let x = 0; x < WORLD_W; x++) {
    if (x < 100) fillCol(x, LOW);
    else if (x < WALL_X) fillCol(x, HIGH);
    else if (x < WALL_X + 10) fillCol(x, WALL_TOP); // 3-tall wall block
    else fillCol(x, WORLD_H - 3); // pit floor far below
  }
}

let invariantHeld = true;

// === Scenario 1 + 2: spawn on low floor, walk right, climb step, stop at wall.
buildTerrainWithWall();
const body: Body = createBody(50, 100); // above the low flat ground

// Settle (no horizontal) so we have a clean resting y.
for (let t = 0; t < 60; t++) {
  updateBody(body);
  assertNoOverlap(body, t, 'settle1');
}
if (!body.grounded) fail('scenario1: body never grounded while settling');
const yRest = Math.round(body.y);
const lowRest = lowestPixelRow(body);
console.log(`Settle: body.y=${yRest}, lowest foot row=${lowRest} (low floor top=${LOW})`);
if (lowRest !== LOW - 1) fail(`settle: lowest foot row ${lowRest}, expected ${LOW - 1}`);

// Walk right.
body.moveDir = 1;
let yBeforeClimb = Math.round(body.y);
let yAfterClimb = yBeforeClimb;
let climbTick = -1;
let stopX = -1;
let lastX = Math.round(body.x);
let stableCount = 0;

for (let t = 0; t < 2000; t++) {
  const yPrev = Math.round(body.y);
  updateBody(body);
  assertNoOverlap(body, t, 'walk');
  const yNow = Math.round(body.y);
  // Detect the climb (resting y decreases by 1 as it mounts the higher floor).
  if (climbTick < 0 && yNow < yPrev) {
    climbTick = t;
    yBeforeClimb = yPrev;
    yAfterClimb = yNow;
  }
  // Detect the wall stop: x stops increasing for a sustained run.
  const xNow = Math.round(body.x);
  if (xNow === lastX) stableCount++;
  else {
    stableCount = 0;
    lastX = xNow;
  }
  if (stableCount > 200 && climbTick >= 0) {
    stopX = xNow;
    break;
  }
}

if (climbTick < 0) fail('scenario1: body never climbed the step');
if (yAfterClimb !== yBeforeClimb - 1) {
  fail(`scenario1: climb changed y by ${yBeforeClimb - yAfterClimb}, expected 1`);
}
console.log(
  `Scenario 1 (climb 1-cell step): y ${yBeforeClimb} -> ${yAfterClimb} at tick ${climbTick}; ` +
    `lowest foot row now ${lowestPixelRow(body)} (raised floor top=${HIGH}) PASS`,
);

if (stopX < 0) fail('scenario2: body never settled against the wall');
// The pixels that can hit the wall are those at/below the wall's solid top row.
const rightFoot = rightmostColAtOrBelow(body, WALL_TOP);
console.log(
  `Scenario 2 (stop at 3-cell wall): body.x stopped at ${stopX}; rightmost colliding pixel col=${rightFoot}; ` +
    `wall starts at x=${WALL_X} (gap=${WALL_X - rightFoot} cells, arm overhangs harmlessly above wall top) PASS`,
);
if (rightFoot >= WALL_X) fail(`scenario2: colliding pixel ${rightFoot} reached/overlapped wall ${WALL_X}`);

// === Scenario 3: wall removed -> a pit. Walk off the ledge, fall in, rest.
const PLAT_END = 200; // raised platform (row HIGH) exists for x < 200
const PIT_FLOOR = HIGH + 7; // pit bottom row (226) — deeper than the platform
function buildTerrainWithPit(): void {
  material.fill(AIR);
  for (let x = 0; x < WORLD_W; x++) {
    if (x < PLAT_END) material[idx(x, HIGH)] = STONE; // thin platform, air below
    else fillCol(x, PIT_FLOOR); // pit basin
  }
}
buildTerrainWithPit();
const body3: Body = createBody(196, 100); // above the platform, near its edge

for (let t = 0; t < 60; t++) {
  updateBody(body3);
  assertNoOverlap(body3, t, 'settle3');
}
if (lowestPixelRow(body3) !== HIGH - 1) {
  fail(`scenario3 settle: lowest foot row ${lowestPixelRow(body3)}, expected ${HIGH - 1}`);
}
const y3Start = Math.round(body3.y);

body3.moveDir = 1;
let restedTick = -1;
for (let t = 0; t < 3000; t++) {
  updateBody(body3);
  assertNoOverlap(body3, t, 'pitfall');
  if (body3.grounded && lowestPixelRow(body3) === PIT_FLOOR - 1) {
    restedTick = t;
    break;
  }
}
if (restedTick < 0) {
  fail(
    `scenario3: body never rested at pit bottom; final y=${Math.round(body3.y)}, ` +
      `lowest=${lowestPixelRow(body3)} (expected ${PIT_FLOOR - 1})`,
  );
}
console.log(
  `Scenario 3 (walk off ledge into pit): started on ledge y=${y3Start}; ` +
    `fell and rested at body.y=${Math.round(body3.y)}, lowest foot row=${lowestPixelRow(body3)} ` +
    `(pit floor top=${PIT_FLOOR}) at tick ${restedTick} PASS`,
);

// No-tunnel invariant held across all runs (assertNoOverlap threw on any breach).
console.log('\nScenario 4: no-tunnel invariant held every tick across all runs PASS');
void invariantHeld;
console.log('\nALL PASS');
