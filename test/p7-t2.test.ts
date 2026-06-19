import { createZombie, updateZombie } from '../src/characters/zombie';
import { createSurvivor } from '../src/characters/survivor';
import { material, set } from '../src/engine/grid';
import { rebuildNavgrid } from '../src/engine/navgrid';
import { STONE } from '../src/engine/materials';
import { WORLD_W, ZOMBIE_IDLE_RADIUS, SENSE_RADIUS } from '../src/config';

function clearGrid() { material.fill(0); }
function floor(row: number) { for (let x = 0; x < WORLD_W; x++) set(x, row, STONE); }
function bodyInStone(b: any): boolean {
  for (const bone of b.rig) {
    if (bone.destroyed) continue;
    for (const p of bone.pixels) {
      const wx = Math.round(b.x) + bone.offset.dx + p.dx;
      const wy = Math.round(b.y) + bone.offset.dy + p.dy;
      if (material[wy * WORLD_W + wx] === STONE) return true;
    }
  }
  return false;
}

const FLOOR = 150;

// =====================================================================
// R1 — survivor OUTSIDE senseRadius: zombie stays idle, x stays local.
// =====================================================================
clearGrid(); floor(FLOOR); rebuildNavgrid();
let tunnel1 = false;
const z1 = createZombie(300, FLOOR - 1);
// Survivor far away (well beyond SENSE_RADIUS), never updated → stationary.
const farSurv = createSurvivor(300 + SENSE_RADIUS + 200, FLOOR - 1);
const startX = Math.round(z1.body.x);
let maxDev = 0, everAttacked = false;
for (let i = 0; i < 600; i++) {
  updateZombie(z1, [farSurv]);
  maxDev = Math.max(maxDev, Math.abs(Math.round(z1.body.x) - startX));
  if (z1.state === 'attack') everAttacked = true;
  if (bodyInStone(z1.body)) tunnel1 = true;
}
const endX = Math.round(z1.body.x);
console.log('R1 idle: startX', startX, 'endX', endX, 'maxDev', maxDev,
  'idleRadius', ZOMBIE_IDLE_RADIUS, 'everAttacked', everAttacked, 'tunnel', tunnel1);
console.log('R1 PASS stayed idle + bounded meander + no-tunnel:',
  !everAttacked && z1.state === 'idle' && maxDev <= 6 * ZOMBIE_IDLE_RADIUS && !tunnel1);

// =====================================================================
// R2 — survivor INSIDE senseRadius: zombie flips to attack and closes
//      the gap monotonically until adjacent. Also measure pursuit speed.
// =====================================================================
clearGrid(); floor(FLOOR); rebuildNavgrid();
let tunnel2 = false;
const z2 = createZombie(300, FLOOR - 1);
// Stationary survivor 40 cells away — inside SENSE_RADIUS (60). Never updated.
const tgt = createSurvivor(340, FLOOR - 1);
// First tick should detect + switch to attack.
updateZombie(z2, [tgt]);
const flipped = z2.state === 'attack';
const initialGap = Math.abs(Math.round(z2.body.x) - Math.round(tgt.body.x));
let prevGap = initialGap, monotone = true;
let pursuitStartX = Math.round(z2.body.x), pursuitTicks = 0;
let finalGap = initialGap;
for (let i = 0; i < 400; i++) {
  updateZombie(z2, [tgt]);
  if (bodyInStone(z2.body)) tunnel2 = true;
  const gap = Math.abs(Math.round(z2.body.x) - Math.round(tgt.body.x));
  // Gap must never grow while pursuing (allow equal — slow ticks don't step).
  if (gap > prevGap + 0.001) monotone = false;
  prevGap = gap;
  finalGap = gap;
  pursuitTicks++;
  if (gap <= 2) break; // adjacent
}
const pursuitDist = Math.abs(Math.round(z2.body.x) - pursuitStartX);
const attackSpeed = pursuitDist / pursuitTicks;
console.log('R2 attack: flipped', flipped, 'initialGap', initialGap,
  'finalGap', finalGap, 'monotone(non-increasing)', monotone, 'tunnel', tunnel2);
console.log('R2 PASS detect+pursue+close+no-tunnel:',
  flipped && finalGap < initialGap && finalGap <= 2 && monotone && !tunnel2);

// =====================================================================
// R3 — measured idle speed vs attack speed (cells/tick).
// =====================================================================
clearGrid(); floor(FLOOR); rebuildNavgrid();
const zi = createZombie(300, FLOOR - 1);
// To get a clean ONE-DIRECTION idle speed, drive idle toward a fixed far goal
// by keeping no survivor in range and summing absolute displacement per tick.
let idlePath = 0;
let px = Math.round(zi.body.x);
for (let i = 0; i < 1200; i++) {
  updateZombie(zi, []);
  const nx = Math.round(zi.body.x);
  idlePath += Math.abs(nx - px);
  px = nx;
}
const idleSpeed = idlePath / 1200;
console.log('R3 idleSpeed', idleSpeed.toFixed(4), 'attackSpeed', attackSpeed.toFixed(4));
console.log('R3 PASS pursuit faster than idle:', attackSpeed > idleSpeed);

console.log('\nSUMMARY',
  'R1', !everAttacked && z1.state === 'idle' && maxDev <= 6 * ZOMBIE_IDLE_RADIUS && !tunnel1,
  'R2', flipped && finalGap < initialGap && finalGap <= 2 && monotone && !tunnel2,
  'R3', attackSpeed > idleSpeed);
