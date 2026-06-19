/**
 * Headless verification for p5-t2 — coarse navgrid + A* router with LOCAL-only
 * path invalidation (GDD §13). Imports the REAL modules (no mocks); seeds terrain
 * directly into grid.material; run via tsc (commonjs) → node.
 *
 * Terrain (all in the left of the world; cleared to AIR first):
 *   - Left ground floor at row 160, x in [40, 69].
 *   - A 1-cell step-up platform at row 159, x in [70, 99]  (reachable: climb 1).
 *   - A WALL (taller than STEP_UP_MAX): stone from row 150 up the column at
 *     x in [100, 103] → top surface row 150, a 9–10 cell climb from any ground.
 *   - Right ground floor at row 160, x in [104, 200] — walled off behind the
 *     wall, so it is UNREACHABLE from the left start.
 *
 * Done-when:
 *   1. findPath(left → platform) returns waypoints whose consecutive coarse
 *      nodes are all walkable and traversable (≤STEP_UP_MAX up / any drop);
 *      findPath(left → walled-off right ground) returns null.
 *   2. The platform route includes the 1-cell climb (succeeds).
 *   3. Invalidation locality: edit ON the path → isPathStale true; recompute;
 *      edit FAR from the path → isPathStale false.
 */
import { material, idx } from '../src/engine/grid';
import { STONE, AIR } from '../src/engine/materials';
import {
  rebuildNavgrid,
  markTerrainEdit,
  isWalkable,
  surfaceY,
  coarseOf,
} from '../src/engine/navgrid';
import { findPath, isPathStale } from '../src/game/pathfinding';
import { WORLD_H, NAV_CELL, STEP_UP_MAX } from '../src/config';

function fail(msg: string): never {
  console.log('FAIL:', msg);
  throw new Error(msg);
}
function ok(msg: string): void {
  console.log('PASS:', msg);
}

// Fill a stone column from `topRow` down a few rows (only the top surface row
// matters for standability, but a thick floor is realistic).
function fillFloor(x: number, topRow: number): void {
  for (let r = topRow; r < Math.min(topRow + 8, WORLD_H); r++) {
    material[idx(x, r)] = STONE;
  }
}

// --- Build terrain -----------------------------------------------------------
material.fill(AIR);
for (let x = 40; x <= 69; x++) fillFloor(x, 160); // left ground
for (let x = 70; x <= 99; x++) fillFloor(x, 159); // 1-cell step platform
for (let x = 100; x <= 103; x++) fillFloor(x, 150); // wall: top at row 150
for (let x = 104; x <= 200; x++) fillFloor(x, 160); // right ground (walled off)
rebuildNavgrid();

// Sanity: the wall column's coarse surface is ~150 and a >STEP_UP_MAX climb from
// the platform (159) — confirms the wall actually blocks ground traversal.
{
  const wc = coarseOf(101, 150);
  const pc = coarseOf(85, 159);
  const climb = surfaceY(pc.cx, pc.cy) - surfaceY(wc.cx, wc.cy);
  console.log(
    `wall coarse surface=${surfaceY(wc.cx, wc.cy)}, platform coarse surface=${surfaceY(pc.cx, pc.cy)}, climb=${climb} (STEP_UP_MAX=${STEP_UP_MAX})`,
  );
  if (climb <= STEP_UP_MAX) fail('wall is not taller than STEP_UP_MAX — setup broken');
}

// === Done-when 1 + 2: reachable path with a 1-cell climb =====================
const path = findPath(50, 159, 85, 158);
if (!path) fail('expected a path from left ground to the reachable platform');
console.log('PATH waypoints (x,y):', path.waypoints.map((w) => `(${w.x},${w.y})`).join(' '));
if (path.waypoints.length < 2) fail('path is too short to be meaningful');

// Start near (50,159), end near (85,158).
const first = path.waypoints[0];
const last = path.waypoints[path.waypoints.length - 1];
if (Math.abs(first.x - 50) > NAV_CELL) fail(`first waypoint x=${first.x} not near start x=50`);
if (Math.abs(last.x - 85) > NAV_CELL) fail(`last waypoint x=${last.x} not near goal x=85`);

// Every waypoint's coarse cell is walkable; consecutive cells are traversable
// (≤STEP_UP_MAX up / any drop) and a 1-cell climb appears somewhere.
let sawClimb = false;
let prevSurf = -1;
let prevCx = -1;
for (const w of path.waypoints) {
  const cx = Math.floor(w.x / NAV_CELL);
  const surf = w.y + 1; // waypoint feet sit one cell above the floor
  const cy = Math.floor(surf / NAV_CELL);
  if (!isWalkable(cx, cy)) fail(`waypoint coarse cell (${cx},${cy}) is not walkable`);
  if (surfaceY(cx, cy) !== surf) fail(`waypoint surface mismatch at (${cx},${cy})`);
  if (prevSurf !== -1) {
    if (Math.abs(cx - prevCx) !== 1) fail('consecutive waypoints are not horizontally adjacent coarse columns');
    const climbUp = prevSurf - surf; // >0 means stepping UP onto a higher floor
    if (climbUp > STEP_UP_MAX) fail(`untraversable climb of ${climbUp} > STEP_UP_MAX between waypoints`);
    if (climbUp === 1) sawClimb = true; // any drop (climbUp<0) is allowed
  }
  prevSurf = surf;
  prevCx = cx;
}
if (!sawClimb) fail('reachable route did not include the 1-cell step climb');
ok('reachable path: all coarse nodes walkable + traversable, includes a 1-cell climb');

// Unreachable goal (right ground, behind the wall) → null.
const blocked = findPath(50, 159, 150, 159);
console.log('UNREACHABLE findPath(50,159 → 150,159) =', blocked);
if (blocked !== null) fail('expected null for the walled-off right ground');
ok('walled-off goal → null (unreachable)');

// === Done-when 3: LOCAL-only invalidation ====================================
// (a) Edit ON the path → stale.
const p1 = findPath(50, 159, 85, 158)!;
// (60,160) lies on the left-ground surface the path crosses.
const onCoarse = coarseOf(60, 160);
const onPath = p1.coarseEpochs.some((e) => e.cx === onCoarse.cx && e.cy === onCoarse.cy);
if (!onPath) fail(`(60,160)'s coarse cell ${onCoarse.cx},${onCoarse.cy} is not on the recorded path`);
material[idx(60, 160)] = AIR; // dig the floor out — a real terrain change
markTerrainEdit(60, 160);
const staleOn = isPathStale(p1);
console.log(`INVALIDATION on-path: edit (60,160) → isPathStale = ${staleOn}`);
if (!staleOn) fail('edit ON the path did NOT mark it stale');
ok('edit on the path → isPathStale true');

// (b) Recompute fresh, then edit FAR from the path → NOT stale.
material[idx(60, 160)] = STONE; // restore the floor
markTerrainEdit(60, 160);
rebuildNavgrid();
const p2 = findPath(50, 159, 85, 158)!;
const farCoarse = coarseOf(500, 160);
const farOnPath = p2.coarseEpochs.some((e) => e.cx === farCoarse.cx && e.cy === farCoarse.cy);
if (farOnPath) fail('test bug: the "far" cell is actually on the path');
material[idx(500, 160)] = STONE; // a genuine edit, far away
markTerrainEdit(500, 160);
const staleFar = isPathStale(p2);
console.log(`INVALIDATION far: edit (500,160) → isPathStale = ${staleFar}`);
if (staleFar) fail('a FAR edit wrongly marked the path stale (invalidation not local)');
ok('edit far from the path → isPathStale false (local-only invalidation)');

console.log('\nALL PASS');
