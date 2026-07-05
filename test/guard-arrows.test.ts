/**
 * Headless verification for guard archery (GDD 7.2): arrows fly a gravity ARC
 * and do BODY-REGION-SPECIFIC damage depending on WHERE they land. Imports the
 * REAL modules (no mocks). tsc (commonjs) -> node.
 *
 * Covers:
 *   1. launchArrow solves a real ARC - the shaft rises above its launch height,
 *      then lands ON the aim cell at ARROW_FLIGHT_TICKS (unobstructed).
 *   2. Region-specific: a shot from ABOVE strikes the HEAD -> the body dissolves
 *      (death); a shot from BELOW strikes a LEG -> the body survives but loses
 *      that leg (crawl). Same body kind, different impact -> different wound.
 *   3. Terrain stops an arrow (it embeds, does not tunnel through a WALL).
 *   4. No friendly fire: arrows are only tested against the zombie list passed
 *      to updateArrows, so a body not in that list is never wounded.
 *   5. The live-arrow pool is hard-bounded by MAX_ARROWS.
 */
import {
  ARROW_FLIGHT_TICKS,
  MAX_ARROWS,
} from '../src/config';
import { material, idx } from '../src/engine/grid';
import { AIR, WALL } from '../src/engine/materials';
import { createBody } from '../src/characters/body';
import type { Body } from '../src/characters/body';
import type { Zombie } from '../src/characters/zombie';
import {
  launchArrow,
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
// 1. ARC: launch from (100,100) to (140,100); over the flight the shaft rises
//    above the launch row, then arrives at the aim cell at tick T.
// ---------------------------------------------------------------------------
clearGrid();
resetArrows();
launchArrow(100, 100, 140, 100);
let minY = Infinity;
let atT = { x: 0, y: 0 };
for (let t = 1; t <= ARROW_FLIGHT_TICKS; t++) {
  updateArrows([]); // no zombies, empty AIR world -> pure flight
  const a = getArrows()[0];
  if (!a) fail('arrow vanished mid-flight over empty AIR world');
  if (a.y < minY) minY = a.y;
  if (t === ARROW_FLIGHT_TICKS) atT = { x: a.x, y: a.y };
}
if (!(minY < 99)) fail(`arrow did not arc UP (min y ${minY.toFixed(2)} not < 99)`);
if (Math.abs(atT.x - 140) > 0.5 || Math.abs(atT.y - 100) > 0.5) {
  fail(`arrow did not land on aim cell (got ${atT.x.toFixed(2)},${atT.y.toFixed(2)})`);
}
ok(`arc: rose to y~${minY.toFixed(1)} then landed on aim (140,100) at tick T`);

// ---------------------------------------------------------------------------
// 2a. REGION from ABOVE -> HEAD -> dissolve. Body feet-centre (200,150); head
//     cells sit at x in {199,200}, y in {139,140,141}. A vertical shot from
//     above descends onto the head first (topmost region).
// ---------------------------------------------------------------------------
clearGrid();
resetArrows();
const headBody = createBody(200, 150);
const flashesBefore = _hitFlashCount();
launchArrow(200, 130, 200, 140); // straight down column x=200 onto the head
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
launchArrow(199, 170, 199, 148); // straight up column x=199 into a leg from below
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
// 3. TERRAIN stops the shaft: a WALL column across the flight path halts the
//    arrow before it can reach the far side (no tunnelling).
// ---------------------------------------------------------------------------
clearGrid();
resetArrows();
for (let y = 90; y <= 110; y++) material[idx(120, y)] = WALL; // wall column at x=120
launchArrow(100, 100, 160, 100);
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

// ---------------------------------------------------------------------------
// 4. NO FRIENDLY FIRE: a body that is NOT in the zombie list passed to
//    updateArrows is never wounded (the guard's arrow ignores the colony).
// ---------------------------------------------------------------------------
clearGrid();
resetArrows();
const friend = createBody(200, 150);
launchArrow(200, 130, 200, 140); // same lethal head shot as 2a...
for (let t = 0; t < 80; t++) updateArrows([]); // ...but no zombies passed
if (!friend.alive) fail('an arrow wounded a body that was not a zombie (friendly fire)');
if (boneDestroyed(friend, 'head')) fail('friendly body took a region hit');
ok('no friendly fire: a non-zombie body in the path is never wounded');

// ---------------------------------------------------------------------------
// 5. POOL CAP: launching well past MAX_ARROWS keeps the list bounded.
// ---------------------------------------------------------------------------
resetArrows();
for (let i = 0; i < MAX_ARROWS + 12; i++) launchArrow(0, 0, 50, 0);
if (getArrows().length > MAX_ARROWS) {
  fail(`arrow pool exceeded MAX_ARROWS (${getArrows().length} > ${MAX_ARROWS})`);
}
ok(`pool: live arrows hard-bounded at MAX_ARROWS (${getArrows().length})`);

console.log('\nALL PASS');
console.log(
  'SUMMARY: arrows arc and land on aim; impact geometry picks the wounded region ' +
    '(above->head/death, below->leg/crawl); terrain embeds; no friendly fire; pool bounded.',
);
