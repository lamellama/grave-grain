/**
 * Headless verification for p4-t4 (THE GATE, gate point 1: leg loss → CRAWL).
 * Imports the REAL modules (no mocks). Seeds terrain directly into grid.material.
 * Run via tsc (commonjs) -> node.
 *
 * Covers GDD §7.2 ("leg pixels drop as cells, rig disables that limb → crawls,
 * much slower") + §5.1 the no-tunnel invariant surviving the degraded gait:
 *   1. Intact body walks D_walk in N ticks at WALK_SPEED.
 *   2. One-legged body crawls D_crawl in the same N ticks; ratio ≈ CRAWL/WALK.
 *   3. One-legged body stays grounded + no-tunnel over 500 ticks on uneven ground.
 *   4. A dead body (head destroyed) passed to updateBody does nothing / no crash.
 */
import { createBody, type Body } from '../src/characters/body';
import { updateBody } from '../src/characters/locomotion';
import { applyDamage } from '../src/characters/damage';
import { material, idx, get } from '../src/engine/grid';
import { isSolidForBody, STONE, AIR } from '../src/engine/materials';
import { WORLD_W, WORLD_H, WALK_SPEED, CRAWL_SPEED } from '../src/config';

function fail(msg: string): never {
  console.log('FAIL:', msg);
  throw new Error(msg);
}
function ok(msg: string): void {
  console.log('PASS:', msg);
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

// Assert NO non-destroyed body pixel currently sits in a solid cell.
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

const N = 200;
const FLOOR = 160; // flat floor top row for the distance runs

// Build a perfectly flat floor across the whole world.
function buildFlat(): void {
  material.fill(AIR);
  for (let x = 0; x < WORLD_W; x++) fillCol(x, FLOOR);
}

// Settle a freshly-spawned body onto the ground (no horizontal drive).
function settle(body: Body, scenario: string): void {
  for (let t = 0; t < 60; t++) {
    updateBody(body);
    assertNoOverlap(body, t, scenario);
  }
  if (!body.grounded) fail(`${scenario}: body never grounded while settling`);
}

// === Scenario 1: intact body walks N ticks on flat ground ===================
buildFlat();
const walker = createBody(80, 100);
settle(walker, 'walk-settle');
const walkStartX = walker.x;
for (let t = 0; t < N; t++) {
  walker.moveDir = 1;
  updateBody(walker);
  assertNoOverlap(walker, t, 'walk');
}
const D_walk = walker.x - walkStartX;

// === Scenario 2: one-legged body crawls N ticks on the same flat ground =====
buildFlat();
const crawler = createBody(80, 100);
settle(crawler, 'crawl-settle');
// THE GATE: destroy the left leg — its pixels release into the live sim and the
// rig disables the limb (GDD §7.2). Body stays alive.
applyDamage(crawler, 'lLeg');
if (!crawler.alive) fail('leg loss must NOT kill the body');
if (!crawler.lLegLost) fail('lLegLost flag not set after applyDamage(lLeg)');
const lowAfterLoss = lowestPixelRow(crawler);
if (lowAfterLoss !== FLOOR - 1) {
  fail(`one-legged body floats/sinks: lowest row ${lowAfterLoss}, expected ${FLOOR - 1}`);
}
const crawlStartX = crawler.x;
for (let t = 0; t < N; t++) {
  crawler.moveDir = 1;
  updateBody(crawler);
  assertNoOverlap(crawler, t, 'crawl');
}
const D_crawl = crawler.x - crawlStartX;

const ratio = D_crawl / D_walk;
const expected = CRAWL_SPEED / WALK_SPEED;
console.log(
  `Distances over N=${N} ticks: D_walk=${D_walk.toFixed(2)} cells, ` +
    `D_crawl=${D_crawl.toFixed(2)} cells, ratio=${ratio.toFixed(3)} ` +
    `(expected≈${expected.toFixed(3)} = CRAWL_SPEED/WALK_SPEED)`,
);
if (Math.abs(ratio - expected) > 0.05) {
  fail(`crawl/walk ratio ${ratio.toFixed(3)} not within 0.05 of ${expected.toFixed(3)}`);
}
if (D_crawl >= D_walk) fail('crawl must be strictly slower than walk');
ok(`leg loss → crawl: one-legged body moves ~${expected.toFixed(2)}× walk speed (much slower), still grounded`);

// === Scenario 3: one-legged body, no-tunnel over 500 ticks on uneven ground =
// Flat stretch then a staircase of 1-cell steps up (climbable via STEP_UP_MAX),
// each held for a run so the crawler climbs them one at a time.
function buildStairs(): void {
  material.fill(AIR);
  for (let x = 0; x < WORLD_W; x++) {
    // Every 30 cells past x=120, the floor rises by 1 cell (gentle staircase).
    let top = FLOOR;
    if (x >= 120) top = FLOOR - Math.min(8, Math.floor((x - 120) / 30) + 1);
    fillCol(x, top);
  }
}
buildStairs();
const climber = createBody(80, 100);
settle(climber, 'stairs-settle');
// Destroy the LEFT (trailing) leg so the released gore pile drops behind the
// rightward-moving body and the staircase ahead is actually exercised. (Losing
// the leading leg would have the body stall against its own shed cells — itself
// a valid no-tunnel outcome, just not a climb test.)
applyDamage(climber, 'lLeg');
if (!climber.alive) fail('leg loss must NOT kill the body (stairs)');
let climbedSteps = 0;
let prevY = Math.round(climber.y);
for (let t = 0; t < 500; t++) {
  climber.moveDir = 1;
  updateBody(climber);
  assertNoOverlap(climber, t, 'stairs');
  // Body must always rest on (or be falling toward) solid — never float forever.
  const yNow = Math.round(climber.y);
  if (yNow < prevY) climbedSteps++;
  prevY = yNow;
}
if (!climber.grounded) fail('stairs: one-legged body not grounded at end of run');
console.log(
  `Stairs (uneven 1-cell steps): one-legged body climbed ${climbedSteps} step(s), ` +
    `ended grounded at y=${Math.round(climber.y)}, lowest foot row=${lowestPixelRow(climber)}`,
);
ok('no-tunnel invariant held EVERY tick over 500 ticks with the degraded (one-legged) gait');

// === Scenario 4: dead body passed to updateBody does nothing / no crash =====
buildFlat();
const corpse = createBody(80, 100);
settle(corpse, 'corpse-settle');
applyDamage(corpse, 'head'); // GDD §7.2: head destroyed → dissolve → alive=false
if (corpse.alive) fail('head destruction must kill the body');
const cx = corpse.x;
const cy = corpse.y;
corpse.moveDir = 1; // try to drive it — must be ignored
for (let t = 0; t < 100; t++) {
  updateBody(corpse); // must not throw
}
if (corpse.x !== cx || corpse.y !== cy) {
  fail(`dead body moved: (${cx},${cy}) -> (${corpse.x},${corpse.y})`);
}
ok('dead body: updateBody is a no-op (no crash, no movement) — cells owned by the sim');

console.log('\nALL PASS');
