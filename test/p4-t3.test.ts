/**
 * Headless verification for p4-t3 (Damage→cells dispatch — THE GATE spine).
 * Imports the REAL modules (no mocks). Run via tsc (commonjs) -> node.
 *
 * Covers GDD §7.2 emergent damage + App. B death-collapse:
 *   1. head  → death + indistinguishable cell pile (full pixel count released)
 *   2. lLeg  → leg lost, alive
 *   3. rArm  → reach lost, alive
 *   4. torso crossing TORSO_DISINTEGRATE_THRESHOLD → dissolve
 *   5. released cells never overwrite terrain (sand/dirt unchanged)
 */
import { WORLD_W, WORLD_H, TORSO_DISINTEGRATE_THRESHOLD } from '../src/config';
import { FLESH, BONE, BLOOD, STONE, SAND, DIRT } from '../src/engine/materials';
import { material, idx, set } from '../src/engine/grid';
import { step } from '../src/engine/simulation';
import { createBody, type Body } from '../src/characters/body';
import { applyDamage, dissolveBody } from '../src/characters/damage';

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
// Read alive through a fn so TS doesn't carry stale property-narrowing across
// the mutating applyDamage() calls (the value really does change).
function isAlive(b: Body): boolean {
  return b.alive;
}
function countMat(pred: (m: number) => boolean): number {
  let n = 0;
  for (let i = 0; i < material.length; i++) if (pred(material[i])) n++;
  return n;
}
function allDestroyed(body: Body): boolean {
  return body.rig.every((b) => b.destroyed);
}
function totalPixels(body: Body): number {
  return body.rig.reduce((s, b) => s + b.pixels.length, 0);
}

const FLOOR_Y = 130;
function freshFloor(): void {
  material.fill(0);
  for (let x = 0; x < WORLD_W; x++) set(x, FLOOR_Y, STONE);
}

// ============================================================================
// 1. HEADSHOT → death-collapse into an indistinguishable cell pile.
// ============================================================================
freshFloor();
{
  const body = createBody(120, FLOOR_Y - 1);
  const original = totalPixels(body); // authored body pixel count

  applyDamage(body, 'head');

  if (isAlive(body) !== false) fail('headshot: isAlive(body) !== false');
  if (!allDestroyed(body)) fail('headshot: not all 6 bones destroyed');

  const cells = countMat(isBodyMat);
  console.log(`headshot: original pixels = ${original}, body cells in grid = ${cells}`);
  if (cells !== original) {
    fail(`headshot: grid holds ${cells} body cells, expected ${original}`);
  }
  ok(`headshot → alive=false, all 6 bones destroyed, ${cells}/${original} pixels released`);

  // Settle the pile; mass conserved, no sprite bones remain, nothing tunnels.
  for (let t = 0; t < 40; t++) step();
  const settled = countMat(isBodyMat);
  if (settled !== original) fail(`headshot: mass changed after settle ${original} -> ${settled}`);
  let below = 0;
  for (let y = FLOOR_Y + 1; y < WORLD_H; y++)
    for (let x = 0; x < WORLD_W; x++) if (isBodyMat(material[idx(x, y)])) below++;
  if (below > 0) fail(`headshot: ${below} cells tunnelled below the floor`);
  if (!allDestroyed(body)) fail('headshot: a bone became un-destroyed (sprite would draw)');
  ok(`headshot pile settled (${settled} cells, 0 below floor, 0 sprite bones) — indistinguishable pile`);
}

// ============================================================================
// 2. LEG → leg lost, still alive.
// ============================================================================
freshFloor();
{
  const body = createBody(200, FLOOR_Y - 1);
  applyDamage(body, 'lLeg');

  const lLeg = body.rig.find((b) => b.name === 'lLeg')!;
  const others = body.rig.filter((b) => b.name !== 'lLeg');
  if (!lLeg.destroyed) fail('lLeg: bone not destroyed');
  if (others.some((b) => b.destroyed)) fail('lLeg: another bone was destroyed');
  if (isAlive(body) !== true) fail('lLeg: isAlive(body) !== true');
  if (body.lLegLost !== true) fail('lLeg: capability flag lLegLost not set');
  ok('lLeg → only lLeg destroyed, alive=true, lLegLost=true');
}

// ============================================================================
// 3. ARM → reach lost that side, still alive.
// ============================================================================
freshFloor();
{
  const body = createBody(300, FLOOR_Y - 1);
  applyDamage(body, 'rArm');

  const rArm = body.rig.find((b) => b.name === 'rArm')!;
  if (!rArm.destroyed) fail('rArm: bone not destroyed');
  if (isAlive(body) !== true) fail('rArm: isAlive(body) !== true');
  if (body.rArmLost !== true) fail('rArm: rArmLost not set');
  if (body.reachRight !== false) fail('rArm: reachRight !== false');
  if (body.reachLeft !== true) fail('rArm: reachLeft wrongly cleared');
  ok('rArm → rArm destroyed, reachRight=false, reachLeft=true, alive=true');
}

// ============================================================================
// 4. TORSO crossing the disintegrate threshold → dissolve.
//    First lose both legs (alive stays true, fraction below threshold), THEN
//    the torso hit pushes cumulative loss past TORSO_DISINTEGRATE_THRESHOLD.
// ============================================================================
freshFloor();
{
  const body = createBody(400, FLOOR_Y - 1);
  const total = totalPixels(body);

  applyDamage(body, 'lLeg');
  applyDamage(body, 'rLeg');
  if (isAlive(body) !== true) fail('torso-threshold: body died on leg loss (should crawl)');

  // Fraction lost BEFORE the torso hit (must be < threshold for a clean test).
  const lostBefore = body.rig.filter((b) => b.destroyed).reduce((s, b) => s + b.pixels.length, 0);
  const fracBefore = lostBefore / total;
  console.log(`torso-threshold: fraction before torso = ${fracBefore.toFixed(3)} (threshold ${TORSO_DISINTEGRATE_THRESHOLD})`);
  if (fracBefore >= TORSO_DISINTEGRATE_THRESHOLD) fail('torso-threshold: setup already over threshold');

  applyDamage(body, 'torso');
  const lostAfter = body.rig.filter((b) => b.destroyed).reduce((s, b) => s + b.pixels.length, 0);
  const fracAfter = lostAfter / total;
  console.log(`torso-threshold: fraction after torso = ${fracAfter.toFixed(3)}`);

  if (fracAfter < TORSO_DISINTEGRATE_THRESHOLD) fail('torso-threshold: torso did not cross threshold (bad setup)');
  if (isAlive(body) !== false) fail('torso-threshold: isAlive(body) !== false after crossing threshold');
  if (!allDestroyed(body)) fail('torso-threshold: dissolve did not destroy all bones');
  ok(`torso crossing threshold (${fracBefore.toFixed(3)} → ${fracAfter.toFixed(3)}) → alive=false, all bones dissolved`);
}

// ============================================================================
// 4b. Sanity: a torso hit ALONE does not cross the threshold (stays alive).
// ============================================================================
freshFloor();
{
  const body = createBody(450, FLOOR_Y - 1);
  applyDamage(body, 'torso');
  const torso = body.rig.find((b) => b.name === 'torso')!;
  if (!torso.destroyed) fail('torso-alone: torso not destroyed');
  if (isAlive(body) !== true) fail('torso-alone: body died from a single torso hit (below threshold)');
  ok('torso alone (< threshold) → torso destroyed, alive=true (bleeds/weakens, no disintegration)');
}

// ============================================================================
// 5. Released cells NEVER overwrite terrain (displaceable narrowing).
//    Seed SAND and DIRT directly inside the body footprint, then dissolve:
//    sand/dirt counts must be unchanged (body cells land only in free/fluid).
// ============================================================================
freshFloor();
{
  const body = createBody(600, FLOOR_Y - 1);
  const rx = Math.round(body.x);
  const ry = Math.round(body.y);

  // Fill the entire body bounding box with SAND/DIRT (alternating columns) so
  // many released pixels would land on terrain if displaceable were too wide.
  let seeded = 0;
  for (const bone of body.rig) {
    for (const p of bone.pixels) {
      const wx = rx + bone.offset.dx + p.dx;
      const wy = ry + bone.offset.dy + p.dy;
      const mat = (wx & 1) === 0 ? SAND : DIRT;
      if (material[idx(wx, wy)] !== mat) {
        set(wx, wy, mat);
        seeded++;
      }
    }
  }
  const sandBefore = countMat((m) => m === SAND);
  const dirtBefore = countMat((m) => m === DIRT);
  console.log(`terrain-guard: seeded ${seeded} terrain cells in footprint (sand=${sandBefore}, dirt=${dirtBefore})`);

  dissolveBody(body);

  const sandAfter = countMat((m) => m === SAND);
  const dirtAfter = countMat((m) => m === DIRT);
  if (sandAfter !== sandBefore) fail(`terrain-guard: SAND count changed ${sandBefore} -> ${sandAfter}`);
  if (dirtAfter !== dirtBefore) fail(`terrain-guard: DIRT count changed ${dirtBefore} -> ${dirtAfter}`);
  ok(`terrain untouched by release (sand ${sandBefore}=${sandAfter}, dirt ${dirtBefore}=${dirtAfter})`);

  // And the floor row is still fully intact.
  let floorIntact = 0;
  for (let x = 0; x < WORLD_W; x++) if (material[idx(x, FLOOR_Y)] === STONE) floorIntact++;
  if (floorIntact !== WORLD_W) fail(`terrain-guard: floor degraded ${floorIntact}/${WORLD_W}`);
  ok(`floor intact (${floorIntact}/${WORLD_W} STONE)`);
}

console.log('\nALL PASS');
console.log(`SUMMARY: headshot pile = full body pixel count; leg/arm keep alive; torso threshold @ ${TORSO_DISINTEGRATE_THRESHOLD}; terrain never clobbered.`);
