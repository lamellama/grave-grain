/**
 * p7-t3 — Zombie melee = BITE that infects (revised death model, GDD §7.2
 * "bite & turning" / §5.1 outcome 3). UPDATED from the original dismember test:
 * a zombie's strike no longer releases cells / destroys bones (that is the
 * GUARD's meleeAttack, covered by p7-t4). A bite marks the target `infected`,
 * leaves it ALIVE, and never trips THE GATE.
 *
 * Verifies (real modules, no mocks): an adjacent attacking zombie bites its
 * target (infected=true, alive=true, no gore, no bone destroyed), the
 * ATTACK_COOLDOWN cadence is respected, repeated bites never kill/dismember, and
 * an out-of-reach zombie never bites. The dismember-via-meleeAttack regression
 * lives in p12-bite (B3) and p7-t4 (guard).
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
// D1 — adjacent zombie BITES: target infected + still alive, NO gore released,
//      NO rig bone destroyed (the bite is not the GATE/dismember path).
// =====================================================================
clearGrid(); floor(FLOOR); rebuildNavgrid();
// Place the zombie ~BODY_W cells from the survivor so they read adjacent on a
// floor without the zombie having to walk.
const z1 = createZombie(306, FLOOR - 1);
const surv1 = createSurvivor(300, FLOOR - 1);
console.log('D1 bodiesAdjacent at spawn:', bodiesAdjacent(z1.body, surv1.body));
const before = goreCells();
let firstBiteTick = -1;
for (let t = 1; t <= ATTACK_COOLDOWN + 2 && firstBiteTick < 0; t++) {
  updateZombie(z1, [surv1]);
  if (surv1.body.infected) firstBiteTick = t;
}
const after = goreCells();
console.log('D1 cells before', before, 'after', after, 'firstBiteTick', firstBiteTick,
  'infected', surv1.body.infected, 'alive', surv1.body.alive,
  'destroyedBones', destroyedBones(surv1.body));
const d1pass = firstBiteTick > 0 && surv1.body.infected && surv1.body.alive &&
  after === before && destroyedBones(surv1.body).length === 0;
console.log('D1 PASS bite infects (no gore, no bone destroyed, alive):', d1pass);

// =====================================================================
// D2 — cooldown respected: over K ticks the zombie re-arms its bite cadence
//      ~K/ATTACK_COOLDOWN times, not every tick.
// =====================================================================
clearGrid(); floor(FLOOR); rebuildNavgrid();
const z2 = createZombie(306, FLOOR - 1);
const surv2 = createSurvivor(300, FLOOR - 1);
const K = 400;
let armings = 0, prevCd = z2.attackCooldown;
for (let t = 1; t <= K; t++) {
  updateZombie(z2, [surv2]);
  if (z2.attackCooldown === ATTACK_COOLDOWN && prevCd < ATTACK_COOLDOWN) armings++;
  prevCd = z2.attackCooldown;
}
const expected = K / ATTACK_COOLDOWN;
console.log('D2 bite-armings (cooldown resets):', armings, 'expected≈', expected.toFixed(1),
  '— each ≥ ATTACK_COOLDOWN ticks apart, not every tick');
const d2pass = armings > 0 && armings <= expected + 1;
console.log('D2 PASS cadence gated:', d2pass);

// =====================================================================
// D3 — repeated bites NEVER kill or dismember: target stays alive + infected,
//      rig intact, no cells released (the turn/progression is Task 4).
// =====================================================================
clearGrid(); floor(FLOOR); rebuildNavgrid();
const z3 = createZombie(306, FLOOR - 1);
const surv3 = createSurvivor(300, FLOOR - 1);
const g3before = goreCells();
for (let t = 1; t <= 2000; t++) updateZombie(z3, [surv3]);
const g3after = goreCells();
console.log('D3 alive', surv3.body.alive, 'infected', surv3.body.infected,
  'destroyedBones', destroyedBones(surv3.body), 'goreCells', g3before, '→', g3after);
const d3pass = surv3.body.alive && surv3.body.infected &&
  destroyedBones(surv3.body).length === 0 && g3after === g3before;
console.log('D3 PASS bites never kill/dismember:', d3pass);

// =====================================================================
// D4 — out-of-reach: zombie far from a stationary survivor beyond senseRadius →
//      never adjacent → never bitten (infected stays false).
// =====================================================================
clearGrid(); floor(FLOOR); rebuildNavgrid();
const z4 = createZombie(300, FLOOR - 1);
const surv4 = createSurvivor(300 + SENSE_RADIUS + 200, FLOOR - 1);
console.log('D4 bodiesAdjacent far:', bodiesAdjacent(z4.body, surv4.body));
for (let t = 1; t <= 600; t++) updateZombie(z4, [surv4]);
console.log('D4 infected', surv4.body.infected, 'survivorAlive', surv4.body.alive);
const d4pass = !surv4.body.infected && surv4.body.alive;
console.log('D4 PASS no bite out of reach:', d4pass);

// pickAttackRegion sanity (still used by the guard dismember path)
const surv5 = createSurvivor(300, FLOOR - 1);
console.log('pickAttackRegion auto (fresh):', pickAttackRegion(surv5.body, 'auto'),
  'head:', pickAttackRegion(surv5.body, 'head'),
  'leg:', pickAttackRegion(surv5.body, 'leg'));

console.log('\nSUMMARY', 'D1', d1pass, 'D2', d2pass, 'D3', d3pass, 'D4', d4pass);
