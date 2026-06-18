/**
 * Headless verification for p4-t6 (THE GATE, gate point 3: set the figure or its
 * shed flesh alight → it burns like the rest of the world). Imports the REAL
 * modules (no mocks). Seeds terrain directly into grid.material. Run via tsc
 * (commonjs) -> node.
 *
 * Covers GDD §7.3 ("flesh is flammable ... it spreads body-to-body") + §5.2:
 *   PART A: a released FLESH cluster on stone, ignited, burns to ASH + SMOKE and
 *           burns out (FIRE→0) — same pattern as a WOOD burn.
 *   PART B: a living body adjacent to FIRE loses ≥1 bone to fire and a sustained
 *           head/torso catch can drive alive=false.
 *   REGRESSION: a living body NOT near fire never spontaneously loses a bone.
 */
import { createBody, type Body } from '../src/characters/body';
import { updateBody } from '../src/characters/locomotion';
import { step, ignite } from '../src/engine/simulation';
import { material, idx, get, placeMaterial } from '../src/engine/grid';
import { STONE, AIR, FLESH, FIRE, ASH, SMOKE } from '../src/engine/materials';
import { WORLD_W, WORLD_H } from '../src/config';

function fail(msg: string): never {
  console.log('FAIL:', msg);
  throw new Error(msg);
}
function ok(msg: string): void {
  console.log('PASS:', msg);
}

const FLOOR = 160;

function clear(): void {
  material.fill(AIR);
}
function buildFlat(): void {
  clear();
  for (let x = 0; x < WORLD_W; x++) {
    for (let r = FLOOR; r < WORLD_H; r++) material[idx(x, r)] = STONE;
  }
}
function settle(body: Body, scenario: string): void {
  for (let t = 0; t < 60; t++) updateBody(body);
  if (!body.grounded) fail(`${scenario}: body never grounded while settling`);
}
function count(mat: number): number {
  let n = 0;
  for (let i = 0; i < material.length; i++) if (material[i] === mat) n++;
  return n;
}
function destroyedBones(body: Body): number {
  return body.rig.filter((b) => b.destroyed).length;
}

// ============================================================================
// PART A — released FLESH cluster ignites, burns, leaves ASH + SMOKE
// ============================================================================
buildFlat();
// A solid FLESH cluster resting on the stone floor (a shed limb pile).
const CX = 120;
const CW = 8;
const CH = 6;
for (let dy = 0; dy < CH; dy++) {
  for (let dx = 0; dx < CW; dx++) {
    placeMaterial(CX + dx, FLOOR - 1 - dy, FLESH);
  }
}
const fleshStart = count(FLESH);
if (fleshStart !== CW * CH) fail(`flesh setup wrong: ${fleshStart} != ${CW * CH}`);

// Ignite one cell on the edge of the cluster.
ignite(CX, FLOOR - 1);

let peakFire = 0;
let burnoutTick = -1;
const MAX_A = 1500;
for (let t = 0; t < MAX_A; t++) {
  step();
  const f = count(FIRE);
  if (f > peakFire) peakFire = f;
  if (f === 0 && t > 5 && burnoutTick < 0) {
    // confirm it actually caught (fire was present then gone)
    if (peakFire > 0) {
      burnoutTick = t;
      break;
    }
  }
}
const finalAsh = count(ASH);
const finalFlesh = count(FLESH);
const finalSmoke = count(SMOKE);
console.log(
  `PART A: peakFire=${peakFire}, burnoutTick=${burnoutTick}, finalAsh=${finalAsh}, ` +
    `finalFlesh=${finalFlesh}, peakSmokeAtBurnout=${finalSmoke}`,
);
if (peakFire <= 0) fail('flesh cluster never caught fire (peakFire=0)');
if (burnoutTick < 0) fail('fire never burned out (FIRE never returned to 0)');
if (finalAsh <= 0) fail('no ASH produced by the burn');
// SMOKE is emitted probabilistically over the burn; confirm it appeared at some
// point by re-running a quick smoke witness over the burn window is overkill —
// ash>0 + smoke seen during burn is enough. Track max smoke instead.
ok(`released FLESH burns like WOOD: spreads (peak ${peakFire}) → burns out (tick ${burnoutTick}), ASH=${finalAsh}`);

// Witness SMOKE during a fresh burn (it dissipates fast, so sample each tick).
buildFlat();
for (let dy = 0; dy < CH; dy++) {
  for (let dx = 0; dx < CW; dx++) placeMaterial(CX + dx, FLOOR - 1 - dy, FLESH);
}
ignite(CX, FLOOR - 1);
let maxSmoke = 0;
for (let t = 0; t < 600; t++) {
  step();
  const s = count(SMOKE);
  if (s > maxSmoke) maxSmoke = s;
  if (count(FIRE) === 0 && t > 5) break;
}
console.log(`PART A: maxSmoke observed during burn = ${maxSmoke}`);
if (maxSmoke <= 0) fail('no SMOKE emitted during the flesh burn');
ok(`SMOKE emitted during burn (max ${maxSmoke} simultaneous cells)`);

// ============================================================================
// PART B — living body adjacent to FIRE loses a bone; sustained fire can kill
// ============================================================================
buildFlat();
const burner = createBody(80, 100);
settle(burner, 'burn-settle');

// Find the body's occupied world cells (all non-destroyed pixels), then lay a
// continuous wall of FIRE in the AIR column directly to the body's LEFT, the
// full height of the figure, so flesh on that side is in contact every tick.
function reignite(body: Body): void {
  const rx = Math.round(body.x);
  const ry = Math.round(body.y);
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const bone of body.rig) {
    if (bone.destroyed) continue;
    for (const p of bone.pixels) {
      const wx = rx + bone.offset.dx + p.dx;
      const wy = ry + bone.offset.dy + p.dy;
      if (wx < minX) minX = wx;
      if (wx > maxX) maxX = wx;
      if (wy < minY) minY = wy;
      if (wy > maxY) maxY = wy;
    }
  }
  // Fire column just left of the figure, plus just right, kept topped up so the
  // contact persists across ticks (fire ages out in FIRE_LIFETIME).
  for (let y = minY; y <= maxY; y++) {
    if (get(minX - 1, y) === AIR) ignite(minX - 1, y);
    if (get(maxX + 1, y) === AIR) ignite(maxX + 1, y);
  }
}

let firstCatchTick = -1;
let deathTick = -1;
const MAX_B = 600;
for (let t = 0; t < MAX_B; t++) {
  reignite(burner); // keep a live fire wall flanking the body
  updateBody(burner);
  step();
  if (firstCatchTick < 0 && destroyedBones(burner) > 0) firstCatchTick = t;
  if (deathTick < 0 && !burner.alive) {
    deathTick = t;
    break;
  }
}
console.log(
  `PART B: firstCatchTick=${firstCatchTick}, destroyedBones=${destroyedBones(burner)}, ` +
    `alive=${burner.alive}, deathTick=${deathTick}`,
);
if (firstCatchTick < 0) fail('body never lost a bone to adjacent fire');
ok(`living body caught fire and shed ≥1 bone (first catch tick ${firstCatchTick})`);
if (!burner.alive) {
  ok(`sustained fire drove the body to death (alive=false at tick ${deathTick})`);
} else {
  // Not a hard failure per the brief ("can drive"), but report honestly.
  console.log('NOTE: body survived MAX_B ticks of fire without dying (still lost bones).');
}

// ============================================================================
// REGRESSION — a living body NOT near fire never spontaneously loses a bone
// ============================================================================
buildFlat();
const safe = createBody(400, 100);
settle(safe, 'safe-settle');
const N = 600;
for (let t = 0; t < N; t++) {
  updateBody(safe);
  step();
  if (destroyedBones(safe) > 0) fail(`safe body lost a bone with no fire near (tick ${t})`);
  if (!safe.alive) fail(`safe body died with no fire near (tick ${t})`);
}
console.log(
  `REGRESSION: safe body over ${N} ticks: destroyedBones=${destroyedBones(safe)}, alive=${safe.alive}`,
);
ok('living body NOT near fire never spontaneously loses a bone over N ticks');

console.log('\nALL PASS');
console.log(
  `SUMMARY: A.peakFire=${peakFire} A.burnout=${burnoutTick} A.ash=${finalAsh} ` +
    `B.firstCatch=${firstCatchTick} B.death=${deathTick}`,
);
