/**
 * Headless verification for the revised death model — Task 1 (corpse state).
 * Imports the REAL modules (no mocks). Run via tsc (commonjs) -> node.
 *
 * Covers GDD §5.1 "Death outcomes":
 *   1. QUIET → corpse: starvation / thirst / drown lay the rig DOWN as a prone
 *      corpse (alive=false, corpse=true, rig INTACT, NO cell spray).
 *   2. EXTREME → dissolve UNCHANGED: a headshot still releases ALL bones into
 *      the live sim (alive=false, corpse=false, full pixel count in the grid).
 */
import { WORLD_W, NEED_MAX, DROWN_TICKS, CORPSE_DECAY_TICKS } from '../src/config';
import { FLESH, BONE, STONE, WATER } from '../src/engine/materials';
import { material, idx, set } from '../src/engine/grid';
import { createBody, type Body } from '../src/characters/body';
import { applyDamage } from '../src/characters/damage';
import { createSurvivor, updateSurvivor, type Survivor } from '../src/characters/survivor';
import { updateBody } from '../src/characters/locomotion';

function fail(msg: string): never {
  console.log('FAIL:', msg);
  throw new Error(msg);
}
function ok(msg: string): void {
  console.log('PASS:', msg);
}
function isBodyMat(m: number): boolean {
  return m === FLESH || m === BONE;
}
function countBodyCells(): number {
  let n = 0;
  for (let i = 0; i < material.length; i++) if (isBodyMat(material[i])) n++;
  return n;
}
function anyDestroyed(body: Body): boolean {
  return body.rig.some((b) => b.destroyed);
}
function allDestroyed(body: Body): boolean {
  return body.rig.every((b) => b.destroyed);
}

const FLOOR_Y = 130;
function freshFloor(): void {
  material.fill(0);
  for (let x = 0; x < WORLD_W; x++) set(x, FLOOR_Y, STONE);
}

// Drive a survivor to a needs-death by zeroing the need, then ticking once.
function runNeedsDeath(which: 'hunger' | 'thirst'): Survivor {
  const s = createSurvivor(200, FLOOR_Y - 1);
  // Drain the targeted need to 0; keep the other full so the cause is unambiguous.
  s.needs.hunger = which === 'hunger' ? 0 : NEED_MAX;
  s.needs.thirst = which === 'thirst' ? 0 : NEED_MAX;
  updateSurvivor(s, []);
  return s;
}

// ============================================================================
// 1a. STARVATION → corpse (rig intact, no cell spray).
// ============================================================================
freshFloor();
{
  const before = countBodyCells();
  const s = runNeedsDeath('hunger');
  const body = s.body;
  const after = countBodyCells();

  if (body.alive !== false) fail('starvation: alive !== false');
  if (body.corpse !== true) fail('starvation: corpse !== true');
  if (body.corpseTicks !== CORPSE_DECAY_TICKS)
    fail(`starvation: corpseTicks ${body.corpseTicks} !== ${CORPSE_DECAY_TICKS}`);
  if (anyDestroyed(body)) fail('starvation: a bone was destroyed (should stay intact)');
  if (after !== before)
    fail(`starvation: grid body-cell count jumped ${before} -> ${after} (corpse must NOT spray cells)`);
  if (s.deathCause !== 'starvation') fail(`starvation: deathCause = ${s.deathCause}`);
  ok(`starvation → corpse (alive=false, corpse=true, 6 bones intact, grid cells ${before}=${after})`);
}

// ============================================================================
// 1b. THIRST → corpse.
// ============================================================================
freshFloor();
{
  const before = countBodyCells();
  const s = runNeedsDeath('thirst');
  const body = s.body;
  const after = countBodyCells();

  if (body.alive !== false) fail('thirst: alive !== false');
  if (body.corpse !== true) fail('thirst: corpse !== true');
  if (anyDestroyed(body)) fail('thirst: a bone was destroyed (should stay intact)');
  if (after !== before) fail(`thirst: grid body-cell count jumped ${before} -> ${after}`);
  if (s.deathCause !== 'thirst') fail(`thirst: deathCause = ${s.deathCause}`);
  ok(`thirst → corpse (alive=false, corpse=true, 6 bones intact, grid cells ${before}=${after})`);
}

// ============================================================================
// 1c. DROWN → corpse (head underwater > DROWN_TICKS via updateBody).
// ============================================================================
freshFloor();
{
  const body = createBody(300, FLOOR_Y - 1);
  // Submerge the head: flood the whole body bounding box (and around) with WATER
  // so the head cells read WATER each tick. The body rests on the stone floor.
  const rx = Math.round(body.x);
  const ry = Math.round(body.y);
  for (let y = ry - 14; y <= ry; y++) {
    for (let x = rx - 6; x <= rx + 6; x++) {
      if (y < FLOOR_Y) set(x, y, WATER);
    }
  }
  const before = countBodyCells();

  let deadAt = -1;
  for (let t = 0; t < DROWN_TICKS + 5; t++) {
    updateBody(body);
    if (!body.alive) {
      deadAt = t;
      break;
    }
  }
  const after = countBodyCells();

  if (deadAt < 0) fail('drown: body never drowned within DROWN_TICKS');
  if (body.alive !== false) fail('drown: alive !== false');
  if (body.corpse !== true) fail('drown: corpse !== true (should lie down, not dissolve)');
  if (anyDestroyed(body)) fail('drown: a bone was destroyed (should stay intact)');
  if (after !== before) fail(`drown: grid body-cell count jumped ${before} -> ${after}`);
  ok(`drown → corpse at tick ${deadAt} (corpse=true, 6 bones intact, grid cells ${before}=${after})`);
}

// ============================================================================
// 2. EXTREME → dissolve UNCHANGED (headshot releases ALL bones into the sim).
// ============================================================================
freshFloor();
{
  const body = createBody(600, FLOOR_Y - 1);
  const total = body.rig.reduce((sum, b) => sum + b.pixels.length, 0);
  const before = countBodyCells();

  applyDamage(body, 'head');

  const after = countBodyCells();
  if (body.alive !== false) fail('headshot: alive !== false');
  if (body.corpse !== false) fail('headshot: corpse !== false (extreme death must NOT be a corpse)');
  if (!allDestroyed(body)) fail('headshot: not all bones destroyed (dissolve regressed)');
  const released = after - before;
  if (released !== total)
    fail(`headshot: released ${released} body cells, expected full ${total}`);
  ok(`headshot → dissolve UNCHANGED (alive=false, corpse=false, all 6 bones destroyed, ${released}/${total} cells released)`);
}

console.log('\nALL PASS');
console.log(
  `SUMMARY: quiet deaths (starve/thirst/drown) lay down as corpses (rig intact, 0 cells sprayed); headshot still dissolves (full pixel release, corpse=false).`,
);
