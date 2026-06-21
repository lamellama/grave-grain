/**
 * p12-bite — Revised death model Task 3: the zombie's BITE infects, it does NOT
 * dismember (GDD §7.2 "bite & turning" / §5.1 outcome 3).
 *
 * Verifies (real modules, no mocks):
 *  B1  An adjacent attacking zombie, once its cooldown lands, BITES its target:
 *      body.infected → true, body STILL ALIVE (a bite doesn't kill outright),
 *      and NOTHING is dismembered — no bone destroyed, no FLESH/BONE sprayed
 *      into the live grid (the rig stays whole; THE GATE is never tripped).
 *  B2  biteAttack is idempotent on an already-infected body and never damages.
 *  B3  Distinct paths: the guard's meleeAttack DOES dismember (destroys a bone +
 *      releases cells) — confirming the bite path is a genuinely separate verb.
 */
import { createZombie, updateZombie } from '../src/characters/zombie';
import { createSurvivor } from '../src/characters/survivor';
import { createBody } from '../src/characters/body';
import { bodiesAdjacent, biteAttack, meleeAttack, pickAttackRegion } from '../src/game/combat';
import { material, set } from '../src/engine/grid';
import { rebuildNavgrid } from '../src/engine/navgrid';
import { STONE, FLESH, BONE } from '../src/engine/materials';
import { WORLD_W, ATTACK_COOLDOWN } from '../src/config';

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
// B1 — adjacent zombie bites its target: infected=true, alive=true, and NO
//      dismember (no bone destroyed, no cells released into the grid).
// =====================================================================
clearGrid(); floor(FLOOR); rebuildNavgrid();
// Place the zombie ~BODY_W cells from the survivor so they read adjacent on a
// floor without the zombie having to walk (so any released cells would be the
// survivor's own — there must be none).
const z1 = createZombie(306, FLOOR - 1);
const surv1 = createSurvivor(300, FLOOR - 1);
console.log('B1 bodiesAdjacent at spawn:', bodiesAdjacent(z1.body, surv1.body));
const goreBefore = goreCells();
let biteTick = -1;
// Run until the first bite lands (cooldown) or a small ceiling.
for (let t = 1; t <= ATTACK_COOLDOWN + 5 && biteTick < 0; t++) {
  updateZombie(z1, [surv1]);
  if (surv1.body.infected) biteTick = t;
}
const goreAfter = goreCells();
const bonesGone = destroyedBones(surv1.body);
console.log('B1 biteTick', biteTick,
  'infected', surv1.body.infected,
  'alive', surv1.body.alive,
  'infectionTicks', surv1.body.infectionTicks,
  'prone', surv1.body.prone,
  'destroyedBones', bonesGone,
  'goreCells before', goreBefore, 'after', goreAfter);
const b1pass =
  biteTick > 0 &&
  surv1.body.infected === true &&
  surv1.body.alive === true &&
  bonesGone.length === 0 &&
  goreAfter === goreBefore;
console.log('B1 PASS bite infects, no dismember (alive, 0 bones, 0 cells):', b1pass);

// =====================================================================
// B2 — keep updating: the zombie re-bites on cadence but NEVER damages an
//      already-infected, still-alive target (no GATE on this path).
// =====================================================================
const goreMid = goreCells();
for (let t = 1; t <= ATTACK_COOLDOWN * 4; t++) updateZombie(z1, [surv1]);
const goreEnd = goreCells();
const bonesEnd = destroyedBones(surv1.body);
console.log('B2 alive', surv1.body.alive, 'destroyedBones', bonesEnd,
  'goreCells', goreMid, '→', goreEnd);
const b2pass = surv1.body.alive === true && bonesEnd.length === 0 && goreEnd === goreMid;
console.log('B2 PASS repeated bites never dismember/kill:', b2pass);

// Direct biteAttack idempotency on a bare body (no controller, no grid writes).
const bare = createBody(50, 50);
console.log('B2b bare defaults infected', bare.infected, 'infectionTicks',
  bare.infectionTicks, 'prone', bare.prone);
biteAttack(bare); // first bite infects
const wasInfected = bare.infected;
biteAttack(bare); // already infected → no-op aside from feedback
const b2bpass =
  bare.infected === true && wasInfected === true &&
  destroyedBones(bare).length === 0;
console.log('B2b PASS biteAttack sets infected, no dismember:', b2bpass);

// =====================================================================
// B3 — distinct verb: the GUARD's meleeAttack DOES dismember (regression that
//      the dismember path is unchanged and separate from the bite path).
// =====================================================================
clearGrid(); floor(FLOOR); rebuildNavgrid();
const victim = createSurvivor(300, FLOOR - 1);
const gBefore = goreCells();
const region = pickAttackRegion(victim.body, 'leg');
meleeAttack(victim.body, region!);
const gAfter = goreCells();
const dBones = destroyedBones(victim.body);
console.log('B3 region', region, 'destroyedBones', dBones,
  'infected', victim.body.infected, 'goreCells', gBefore, '→', gAfter);
const b3pass =
  dBones.length > 0 &&
  gAfter > gBefore &&
  victim.body.infected === false; // dismember path never infects
console.log('B3 PASS guard meleeAttack still dismembers (cells + bone):', b3pass);

console.log('\nSUMMARY', 'B1', b1pass, 'B2', b2pass && b2bpass, 'B3', b3pass);
