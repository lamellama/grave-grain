/**
 * p7-t3 — Melee combat primitives + zombie strike, routed through THE GATE.
 *
 * Verifies (real modules, no mocks): an adjacent attacking zombie wounds its
 * target via applyDamage (cells released into the grid + rig bone destroyed),
 * the ATTACK_COOLDOWN cadence is respected, repeated strikes eventually kill
 * (alive→false via dissolve), and an out-of-reach zombie does NO damage.
 */
import { createZombie, updateZombie } from '../src/characters/zombie';
import { createSurvivor } from '../src/characters/survivor';
import { bodiesAdjacent, pickAttackRegion } from '../src/game/combat';
import { material, set } from '../src/engine/grid';
import { rebuildNavgrid } from '../src/engine/navgrid';
import { STONE, FLESH, BONE } from '../src/engine/materials';
import { WORLD_W, ATTACK_COOLDOWN, SENSE_RADIUS } from '../src/config';

function clearGrid() { material.fill(0); }
function floor(row: number) { for (let x = 0; x < WORLD_W; x++) set(x, row, STONE); }
function goreCells(): number {
  let n = 0;
  for (let i = 0; i < material.length; i++) {
    if (material[i] === FLESH || material[i] === BONE) n++;
  }
  return n;
}
function destroyedBones(b: any): string[] {
  return b.rig.filter((bone: any) => bone.destroyed).map((bone: any) => bone.name);
}

const FLOOR = 150;

// =====================================================================
// D1 — adjacent zombie strikes after ATTACK_COOLDOWN ticks: cells rise,
//      a rig bone is destroyed.
// =====================================================================
clearGrid(); floor(FLOOR); rebuildNavgrid();
// Place the zombie ~BODY_W cells from the survivor so they read adjacent on a
// floor without the zombie having to walk (gore from the survivor only).
const z1 = createZombie(306, FLOOR - 1);
const surv1 = createSurvivor(300, FLOOR - 1);
console.log('D1 bodiesAdjacent at spawn:', bodiesAdjacent(z1.body, surv1.body));
const before = goreCells();
let firstStrikeTick = -1, firstBone = '';
for (let t = 1; t <= ATTACK_COOLDOWN + 2 && firstStrikeTick < 0; t++) {
  updateZombie(z1, [surv1]);
  const ds = destroyedBones(surv1.body);
  if (ds.length > 0) { firstStrikeTick = t; firstBone = ds[0]; }
}
const after = goreCells();
console.log('D1 cells before', before, 'after', after, 'firstStrikeTick', firstStrikeTick,
  'firstBone', firstBone);
console.log('D1 PASS strike releases cells + destroys a bone:',
  after > before && firstStrikeTick > 0 && firstBone !== '');

// =====================================================================
// D2 — cooldown respected: over K ticks, #strikes ≈ K/ATTACK_COOLDOWN.
// =====================================================================
clearGrid(); floor(FLOOR); rebuildNavgrid();
const z2 = createZombie(306, FLOOR - 1);
const surv2 = createSurvivor(300, FLOOR - 1);
const K = 400;
let strikes = 0, prevDestroyed = 0, deathAt2 = -1;
for (let t = 1; t <= K; t++) {
  const aliveBefore = surv2.body.alive;
  updateZombie(z2, [surv2]);
  const nd = destroyedBones(surv2.body).length;
  if (nd > prevDestroyed) strikes += (nd - prevDestroyed); // count fresh destructions
  prevDestroyed = nd;
  if (aliveBefore && !surv2.body.alive && deathAt2 < 0) deathAt2 = t;
}
const expected = K / ATTACK_COOLDOWN;
console.log('D2 strikes', strikes, 'expected≈', expected.toFixed(1),
  'over K', K, 'cooldown', ATTACK_COOLDOWN, '(note: a single dissolve destroys many bones at once)');
// A dissolve destroys all remaining bones in one strike, so destroyed-bone count
// is an UPPER bound on # GATE calls; the meaningful cadence check is that the
// total number of applyDamage *opportunities* is bounded by K/cooldown. We
// measure strike opportunities directly below in D2b.

// D2b — count actual strike opportunities (cooldown resets) on a FRESH survivor
// that we keep "alive" by aiming at legs/arms only is overkill; instead count
// how many times the zombie's cooldown was (re)armed by instrumenting ticks
// where a destruction first appeared OR cooldown jumped to ATTACK_COOLDOWN.
clearGrid(); floor(FLOOR); rebuildNavgrid();
const z2b = createZombie(306, FLOOR - 1);
const surv2b = createSurvivor(300, FLOOR - 1);
let armings = 0, prevCd = z2b.attackCooldown;
for (let t = 1; t <= K; t++) {
  if (!surv2b.body.alive) break; // dead target → no more strikes
  updateZombie(z2b, [surv2b]);
  if (z2b.attackCooldown === ATTACK_COOLDOWN && prevCd < ATTACK_COOLDOWN) armings++;
  prevCd = z2b.attackCooldown;
}
console.log('D2b strike-armings (cooldown resets):', armings,
  '— each ≥ ATTACK_COOLDOWN ticks apart, not every tick');
console.log('D2 PASS cadence gated (armings small vs K):', armings > 0 && armings <= expected + 1);

// =====================================================================
// D3 — repeated strikes eventually kill (alive→false via dissolve).
// =====================================================================
clearGrid(); floor(FLOOR); rebuildNavgrid();
const z3 = createZombie(306, FLOOR - 1);
const surv3 = createSurvivor(300, FLOOR - 1);
let deathTick = -1;
for (let t = 1; t <= 2000; t++) {
  updateZombie(z3, [surv3]);
  if (!surv3.body.alive) { deathTick = t; break; }
}
console.log('D3 tick-of-death', deathTick, 'destroyedBones', destroyedBones(surv3.body));
console.log('D3 PASS survivor dies via dissolve:', deathTick > 0 && !surv3.body.alive);

// =====================================================================
// D4 — out-of-reach: zombie far from a (never-updated, stationary) survivor
//      beyond senseRadius → never adjacent → NO bone destroyed.
// =====================================================================
clearGrid(); floor(FLOOR); rebuildNavgrid();
const z4 = createZombie(300, FLOOR - 1);
const surv4 = createSurvivor(300 + SENSE_RADIUS + 200, FLOOR - 1);
console.log('D4 bodiesAdjacent far:', bodiesAdjacent(z4.body, surv4.body));
for (let t = 1; t <= 600; t++) updateZombie(z4, [surv4]);
const d4destroyed = destroyedBones(surv4.body);
console.log('D4 destroyedBones', d4destroyed, 'survivorAlive', surv4.body.alive);
console.log('D4 PASS no damage out of reach:', d4destroyed.length === 0 && surv4.body.alive);

// pickAttackRegion sanity
const surv5 = createSurvivor(300, FLOOR - 1);
console.log('pickAttackRegion auto (fresh):', pickAttackRegion(surv5.body, 'auto'),
  'head:', pickAttackRegion(surv5.body, 'head'),
  'leg:', pickAttackRegion(surv5.body, 'leg'));

console.log('\nSUMMARY',
  'D1', after > before && firstStrikeTick > 0 && firstBone !== '',
  'D2', armings > 0 && armings <= expected + 1,
  'D3', deathTick > 0 && !surv3.body.alive,
  'D4', d4destroyed.length === 0 && surv4.body.alive);
