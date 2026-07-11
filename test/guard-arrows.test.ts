/**
 * Headless verification for guard archery (GDD 7.2 + round 11): arrows fly a
 * gravity ARC at a FIXED muzzle speed and do BODY-REGION-SPECIFIC damage
 * depending on WHERE they land. Imports the REAL modules (no mocks).
 * tsc (commonjs) -> node.
 *
 * Covers:
 *   1. aimArrow returns a launch at ARROW_SPEED whose integrated flight rises
 *      above the launch height (a real ARC) and arrives at the aim point.
 *   2. Region-specific: a shot from ABOVE strikes the HEAD -> the body
 *      dissolves (death); a shot from BELOW strikes a LEG -> the body survives
 *      but loses that leg (crawl). Same body kind, different impact ->
 *      different wound.
 *   3. Terrain stops an arrow (it embeds, does not tunnel through a WALL) -
 *      and aimArrow answers a blocked flat lane with the HIGH LOB, whose
 *      flight clears the same wall (round 11 "smart enough to shoot over
 *      walls").
 *   4. No friendly fire: arrows are only tested against the zombie list passed
 *      to updateArrows, so a body not in that list is never wounded.
 *   5. The live-arrow pool is hard-bounded by MAX_ARROWS.
 */
import {
  ARROW_SPEED,
  MAX_ARROWS,
} from '../src/config';
import { material, idx } from '../src/engine/grid';
import { AIR, WALL } from '../src/engine/materials';
import { createBody } from '../src/characters/body';
import type { Body } from '../src/characters/body';
import type { Zombie } from '../src/characters/zombie';
import {
  aimArrow,
  solveArcs,
  spawnArrow,
  updateArrows,
  getArrows,
  resetArrows,
} from '../src/game/projectiles';
import { _hitFlashCount } from '../src/game/ui';

function fail(msg: string): never {
  console.log('FAIL:', msg);
  throw new Error(msg);
}
function ok(msg: string): void {
  console.log('PASS:', msg);
}

/** Wrap a bare Body as a Zombie for updateArrows (it only reads z.body). */
function asZombie(body: Body): Zombie {
  return { body } as unknown as Zombie;
}

/** Clear the whole material grid back to AIR (tests share one global grid). */
function clearGrid(): void {
  material.fill(AIR);
}

function boneDestroyed(body: Body, name: string): boolean {
  const b = body.rig.find((r) => r.name === name);
  return !!b && b.destroyed;
}

// ---------------------------------------------------------------------------
// 1. ARC: aim from (100,100) to (140,100); the launch is at ARROW_SPEED, and
//    over the flight the shaft rises above the launch row then arrives near
//    the aim point (the integrator and the closed-form solve agree).
// ---------------------------------------------------------------------------
clearGrid();
resetArrows();
const aim1 = aimArrow(100, 100, 140, 100);
if (!aim1) fail('no firing solution for a flat 40-cell shot');
const launchSpeed = Math.hypot(aim1.vx, aim1.vy);
if (Math.abs(launchSpeed - ARROW_SPEED) > 1e-6) {
  fail(`launch speed ${launchSpeed.toFixed(3)} != ARROW_SPEED ${ARROW_SPEED}`);
}
spawnArrow(100, 100, aim1.vx, aim1.vy);
let minY = Infinity;
let nearest = Infinity;
for (let t = 1; t <= 120 && getArrows().length > 0; t++) {
  updateArrows([]); // no zombies, empty AIR world -> pure flight
  const a = getArrows()[0];
  if (!a) break;
  if (a.y < minY) minY = a.y;
  const d = Math.hypot(a.x - 140, a.y - 100);
  if (d < nearest) nearest = d;
}
if (!(minY < 99)) fail(`arrow did not arc UP (min y ${minY.toFixed(2)} not < 99)`);
if (nearest > 2) fail(`arrow never came near the aim point (closest ${nearest.toFixed(2)} cells)`);
ok(`arc: launched at ARROW_SPEED, rose to y~${minY.toFixed(1)}, passed within ${nearest.toFixed(2)} cells of the aim`);

// ---------------------------------------------------------------------------
// 2a. REGION from ABOVE -> HEAD -> dissolve. Body feet-centre (200,150); head
//     cells sit at x in {199,200}, y in {139,140,141}. A vertical shot from
//     above descends onto the head first (topmost region).
// ---------------------------------------------------------------------------
clearGrid();
resetArrows();
const headBody = createBody(200, 150);
const flashesBefore = _hitFlashCount();
spawnArrow(200, 130, 0, ARROW_SPEED); // straight down column x=200 onto the head
for (let t = 0; t < 80 && headBody.alive; t++) {
  updateArrows([asZombie(headBody)]);
}
if (headBody.alive) fail('head shot did not kill the body (still alive)');
if (!boneDestroyed(headBody, 'head')) fail('head shot did not destroy the head bone');
if (_hitFlashCount() <= flashesBefore) fail('head shot registered no hit flash');
if (getArrows().length !== 0) fail('head-shot arrow was not consumed on impact');
ok('region: an arrow from ABOVE strikes the head -> body dissolves (death)');

// ---------------------------------------------------------------------------
// 2b. REGION from BELOW -> LEG -> the body SURVIVES but loses that leg (crawl).
//     Same body kind; the DIFFERENT impact point is what changes the wound.
// ---------------------------------------------------------------------------
clearGrid();
resetArrows();
const legBody = createBody(200, 150); // legs occupy y in {147..150}
spawnArrow(199, 170, 0, -ARROW_SPEED); // straight up column x=199 into a leg from below
let legHit = false;
for (let t = 0; t < 80; t++) {
  updateArrows([asZombie(legBody)]);
  if (legBody.lLegLost || legBody.rLegLost) {
    legHit = true;
    break;
  }
}
if (!legHit) fail('shot from below never struck a leg');
if (!legBody.alive) fail('a leg wound must NOT kill the body (crawl, not death)');
if (boneDestroyed(legBody, 'head')) fail('a leg shot wrongly destroyed the head');
ok('region: an arrow from BELOW strikes a leg -> body survives, leg lost (crawl)');

// ---------------------------------------------------------------------------
// 3. TERRAIN stops the shaft: a WALL column across a flat flight path halts
//    the arrow (no tunnelling) - and aimArrow answers the SAME blocked lane
//    with the HIGH LOB, whose integrated flight clears the wall top (round 11
//    "smart enough to shoot over walls").
// ---------------------------------------------------------------------------
clearGrid();
resetArrows();
for (let y = 90; y <= 110; y++) material[idx(120, y)] = WALL; // wall column at x=120
const flat3 = solveArcs(60, 0)[0]; // the LOW arc, fired blind into the wall
spawnArrow(100, 100, flat3.vx, flat3.vy);
let maxX = -Infinity;
for (let t = 0; t < 120; t++) {
  updateArrows([]);
  const a = getArrows()[0];
  if (!a) break; // embedded + pruned
  if (a.x > maxX) maxX = a.x;
}
if (getArrows().length !== 0) fail('arrow flew through the WALL (never embedded)');
if (maxX > 122) fail(`arrow tunnelled past the wall (reached x ${maxX.toFixed(1)})`);
ok(`terrain: arrow embedded at the WALL (x~${maxX.toFixed(1)}), did not tunnel`);

// The smart shot: aimArrow rejects the blocked flat arc and returns the lob...
const aim3 = aimArrow(100, 100, 160, 100);
if (!aim3) fail('aimArrow found no solution despite a clear lob over the wall');
if (!(aim3.vy < flat3.vy)) {
  fail(`aimArrow did not choose a steeper launch (vy ${aim3.vy.toFixed(2)} vs flat ${flat3.vy.toFixed(2)})`);
}
// ...and the lobbed flight actually clears the wall and reaches the far side.
resetArrows();
spawnArrow(100, 100, aim3.vx, aim3.vy);
let nearest3 = Infinity;
for (let t = 0; t < 240 && getArrows().length > 0; t++) {
  updateArrows([]);
  const a = getArrows()[0];
  if (!a) break;
  const d = Math.hypot(a.x - 160, a.y - 100);
  if (d < nearest3) nearest3 = d;
}
if (nearest3 > 2) fail(`the lob never reached the target beyond the wall (closest ${nearest3.toFixed(2)})`);
ok(`over the wall: aimArrow lobbed the shaft over the parapet to the far target (within ${nearest3.toFixed(2)} cells)`);

// ---------------------------------------------------------------------------
// 4. NO FRIENDLY FIRE: a body that is NOT in the zombie list passed to
//    updateArrows is never wounded (the guard's arrow ignores the colony).
// ---------------------------------------------------------------------------
clearGrid();
resetArrows();
const friend = createBody(200, 150);
spawnArrow(200, 130, 0, ARROW_SPEED); // same lethal head shot as 2a...
for (let t = 0; t < 80; t++) updateArrows([]); // ...but no zombies passed
if (!friend.alive) fail('an arrow wounded a body that was not a zombie (friendly fire)');
if (boneDestroyed(friend, 'head')) fail('friendly body took a region hit');
ok('no friendly fire: a non-zombie body in the path is never wounded');

// ---------------------------------------------------------------------------
// 5. POOL CAP: spawning well past MAX_ARROWS keeps the list bounded.
// ---------------------------------------------------------------------------
resetArrows();
for (let i = 0; i < MAX_ARROWS + 12; i++) spawnArrow(0, 0, 1, 0);
if (getArrows().length > MAX_ARROWS) {
  fail(`arrow pool exceeded MAX_ARROWS (${getArrows().length} > ${MAX_ARROWS})`);
}
ok(`pool: live arrows hard-bounded at MAX_ARROWS (${getArrows().length})`);

console.log('\nALL PASS');
console.log(
  'SUMMARY: arrows launch at fixed ARROW_SPEED and arc onto the aim; impact geometry ' +
    'picks the wounded region (above->head/death, below->leg/crawl); terrain embeds the ' +
    'flat shot and aimArrow lobs over it; no friendly fire; pool bounded.',
);
