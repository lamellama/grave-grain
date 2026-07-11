/**
 * test/p11-lod.test.ts — Phase 11 task 11-3: Body LOD throttle + gore
 * age/settle trickle. Real modules (no mocks). tsc(commonjs) -> node.
 *
 * Covers GDD §13 ("LOD for distant/idle bodies" + "fade/settle gore over time"):
 *
 *  1. LOD throttle — a FAR off-screen IDLE survivor and idle zombie have their
 *     controller gated to ~1/BODY_LOD_THROTTLE ticks, while an on-screen body
 *     and a FAR-but-PURSUING zombie run EVERY tick.
 *  2. Never throttle combat/fall — a mid-fall body, a zombie in 'attack', and a
 *     body being attacked all run every tick; and a real far-off-screen combat
 *     driven THROUGH the LOD gate still lands hits (leg loss).
 *  3. Gore trickle-fade — a modest pile UNDER MAX_GORE_CELLS ages out (count
 *     DECREASES) after GORE_SETTLE_TICKS, with NO premature fade before then and
 *     terrain never touched.
 */
import {
  CELL_SIZE,
  WORLD_W,
  WORLD_H,
  BODY_LOD_THROTTLE,
  BODY_LOD_OFFSCREEN_MARGIN,
  MAX_GORE_CELLS,
  GORE_SETTLE_TICKS,
  GORE_AGE_FADE_PER_TICK,
} from '../src/config';
import {
  lodWindow,
  isFar,
  survivorShouldRun,
  zombieShouldRun,
} from '../src/game/lod';
import { updateArrows, resetArrows } from '../src/game/projectiles';
import { createSurvivor, updateSurvivor, assignRole } from '../src/characters/survivor';
import { createZombie, updateZombie } from '../src/characters/zombie';
import { makeTool } from '../src/game/roles';
import { material, idx, set } from '../src/engine/grid';
import { rebuildNavgrid } from '../src/engine/navgrid';
import { step } from '../src/engine/simulation';
import { STONE, FLESH, BONE, BLOOD, AIR } from '../src/engine/materials';

function fail(msg: string): never {
  console.log('FAIL:', msg);
  throw new Error(msg);
}
function ok(msg: string): void {
  console.log('PASS:', msg);
}

// A 1280x720 viewport at the default zoom (cellPx = CELL_SIZE). Camera at the
// origin → visible window roughly cells x[0..213] y[0..120].
const VP_W = 1280;
const VP_H = 720;
const win = lodWindow(0, 0, VP_W, VP_H, CELL_SIZE);
console.log(
  `window minX=${win.minX} maxX=${win.maxX.toFixed(0)} minY=${win.minY} ` +
    `maxY=${win.maxY.toFixed(0)} margin=${BODY_LOD_OFFSCREEN_MARGIN}`,
);

// Sanity on the geometry the throttle relies on.
const FAR_X = 900; // well past maxX + margin
const NEAR_X = 100; // inside the window
if (!isFar(FAR_X, 50, win)) fail(`x=${FAR_X} should be far off-screen`);
if (isFar(NEAR_X, 50, win)) fail(`x=${NEAR_X} should be on-screen`);
ok(`geometry: x=${FAR_X} far, x=${NEAR_X} on-screen`);

const N = 400; // ticks to measure call cadence over

// ===========================================================================
// 1. LOD THROTTLE — far + idle gets ~1/THROTTLE; on-screen / pursuing = every.
// ===========================================================================

// (a) FAR IDLE survivor: behaviour 'wander', role 'none', grounded → eligible.
const idleSurv = createSurvivor(FAR_X, 50);
idleSurv.body.grounded = true; // pretend settled on ground (predicate reads this)
let idleSurvRuns = 0;
for (let t = 0; t < N; t++) {
  if (survivorShouldRun(idleSurv, 0, win, [], t)) idleSurvRuns++;
}

// (b) FAR IDLE zombie: state 'idle', grounded → eligible.
const idleZom = createZombie(FAR_X, 50);
idleZom.body.grounded = true;
idleZom.state = 'idle';
let idleZomRuns = 0;
for (let t = 0; t < N; t++) {
  if (zombieShouldRun(idleZom, 0, win, [], t)) idleZomRuns++;
}

// (c) ON-SCREEN idle survivor: inside the window → NEVER throttled.
const onScreen = createSurvivor(NEAR_X, 50);
onScreen.body.grounded = true;
let onScreenRuns = 0;
for (let t = 0; t < N; t++) {
  if (survivorShouldRun(onScreen, 0, win, [], t)) onScreenRuns++;
}

// (d) FAR PURSUING zombie: state 'attack' → NEVER throttled even when far.
const pursueZom = createZombie(FAR_X, 50);
pursueZom.body.grounded = true;
pursueZom.state = 'attack';
let pursueRuns = 0;
for (let t = 0; t < N; t++) {
  if (zombieShouldRun(pursueZom, 0, win, [], t)) pursueRuns++;
}

const expectThrottled = N / BODY_LOD_THROTTLE; // 100 for N=400, THROTTLE=4
console.log(
  `runs over ${N} ticks: idleSurv=${idleSurvRuns} idleZom=${idleZomRuns} ` +
    `onScreen=${onScreenRuns} pursuing=${pursueRuns} (expectThrottled≈${expectThrottled})`,
);
const tol = 2;
if (Math.abs(idleSurvRuns - expectThrottled) > tol) {
  fail(`far idle survivor runs ${idleSurvRuns}, expected ≈${expectThrottled}`);
}
if (Math.abs(idleZomRuns - expectThrottled) > tol) {
  fail(`far idle zombie runs ${idleZomRuns}, expected ≈${expectThrottled}`);
}
ok(`far+idle survivor & zombie throttled to ≈N/${BODY_LOD_THROTTLE} (${idleSurvRuns}, ${idleZomRuns})`);
if (onScreenRuns !== N) fail(`on-screen body throttled (${onScreenRuns}/${N})`);
if (pursueRuns !== N) fail(`far PURSUING zombie throttled (${pursueRuns}/${N})`);
ok(`on-screen body & far-pursuing zombie run EVERY tick (${onScreenRuns}, ${pursueRuns})`);

// ===========================================================================
// 2. NEVER THROTTLE combat / fall.
// ===========================================================================

// (a) Mid-fall body (grounded=false) is far+idle but must run every tick.
const fallingSurv = createSurvivor(FAR_X, 50);
fallingSurv.body.grounded = false; // mid-air
let fallingRuns = 0;
for (let t = 0; t < N; t++) {
  if (survivorShouldRun(fallingSurv, 0, win, [], t)) fallingRuns++;
}
if (fallingRuns !== N) fail(`mid-fall body throttled (${fallingRuns}/${N})`);
ok(`mid-fall body runs EVERY tick (${fallingRuns}/${N})`);

// (b) Being attacked: far+idle survivor with an opposing body adjacent → every.
const attackedSurv = createSurvivor(FAR_X, 50);
attackedSurv.body.grounded = true;
const attackerBody = createZombie(FAR_X + 3, 50).body; // within melee adjacency
attackerBody.alive = true;
let attackedRuns = 0;
for (let t = 0; t < N; t++) {
  if (survivorShouldRun(attackedSurv, 0, win, [attackerBody], t)) attackedRuns++;
}
if (attackedRuns !== N) fail(`being-attacked body throttled (${attackedRuns}/${N})`);
ok(`body being attacked runs EVERY tick (${attackedRuns}/${N})`);

// (c) Real FAR-off-screen combat driven through the LOD gate still lands hits.
//     A guard + a zombie, both far off-screen, simulated with the SAME gate the
//     main loop uses: the guard (role 'guard' → not idle) and the attacking
//     zombie (state 'attack') are never throttled, so the guard LEGs the zombie.
material.fill(AIR);
const FLOOR = 150;
for (let x = 0; x < WORLD_W; x++) set(x, FLOOR, STONE);
rebuildNavgrid();
const cguard = createSurvivor(FAR_X, FLOOR - 1);
cguard.tool = makeTool('weapon');
assignRole(cguard, 'guard');
const czom = createZombie(FAR_X + 20, FLOOR - 1);
if (!isFar(cguard.body.x, cguard.body.y, win)) fail('combat scene not far off-screen');
let legLossTick = -1;
let guardRan = 0;
let zomRan = 0;
const combatSurvBodies = [cguard.body];
const combatZomBodies = [czom.body];
resetArrows();
for (let t = 1; t <= 1500; t++) {
  if (zombieShouldRun(czom, 0, win, combatSurvBodies, t)) {
    updateZombie(czom, [cguard]);
    zomRan++;
  }
  if (survivorShouldRun(cguard, 0, win, combatZomBodies, t)) {
    updateSurvivor(cguard, [czom]);
    guardRan++;
  }
  // Guards are ARCHERS now: fly this tick's arrows exactly like the main loop
  // does (updateArrows is not LOD-gated - shafts are cheap and few).
  updateArrows([czom]);
  // Archer guards volley at torso mass, so the wound that actually lands is
  // whatever region the arc strikes (often a one-shot torso kill) - any bone
  // loss or a kill proves combat carried through the LOD gate.
  const wounded =
    !czom.body.alive || czom.body.rig.some((b) => b.destroyed);
  if (legLossTick < 0 && wounded) {
    legLossTick = t;
    break;
  }
}
console.log(
  `far combat: guardRan=${guardRan} zomRan=${zomRan} legLossTick=${legLossTick} ` +
    `lLeg=${czom.body.lLegLost} rLeg=${czom.body.rLegLost}`,
);
if (legLossTick < 0) fail('far-off-screen combat through the LOD gate missed (no wound landed)');
ok(`far combat through the gate lands hits — zombie wounded @t${legLossTick}`);

// ===========================================================================
// 3. GORE TRICKLE-FADE — old debris ages out under the cap; no premature fade.
// ===========================================================================
function isLooseDebris(m: number): boolean {
  return m === FLESH || m === BONE || m === BLOOD;
}
function countDebris(): number {
  let n = 0;
  for (let i = 0; i < material.length; i++) if (isLooseDebris(material[i])) n++;
  return n;
}
function countMat(target: number): number {
  let n = 0;
  for (let i = 0; i < material.length; i++) if (material[i] === target) n++;
  return n;
}

material.fill(AIR);
const GFLOOR = WORLD_H - 4;
for (let x = 0; x < WORLD_W; x++) set(x, GFLOOR, STONE);
const floorStoneBefore = countMat(STONE);

// Seed a MODEST pile WELL UNDER the cap so we exercise the under-cap trickle
// (the over-cap fast fade is covered by p10-gore).
let seeded = 0;
for (let y = GFLOOR - 8; y < GFLOOR; y++) {
  for (let x = 40; x < 160; x++) {
    if (material[idx(x, y)] !== AIR) continue;
    const r = (x + y) % 3;
    set(x, y, r === 0 ? BLOOD : r === 1 ? BONE : FLESH);
    seeded++;
  }
}
console.log(`gore seeded = ${seeded} (cap = ${MAX_GORE_CELLS}, under-cap)`);
if (seeded >= MAX_GORE_CELLS) fail('gore seed not under the cap — test invalid');

// Sample the debris count across the settle window.
const samples: Record<number, number> = {};
samples[0] = countDebris();
const PRE = GORE_SETTLE_TICKS - 100; // before the trickle can start
const POST = GORE_SETTLE_TICKS + 500; // well after it starts
for (let t = 1; t <= POST; t++) {
  step();
  if (t === 1500 || t === PRE || t === GORE_SETTLE_TICKS || t === POST) {
    samples[t] = countDebris();
  }
}
console.log(
  `gore curve: t0=${samples[0]} t1500=${samples[1500]} ` +
    `t${PRE}=${samples[PRE]} t${GORE_SETTLE_TICKS}=${samples[GORE_SETTLE_TICKS]} ` +
    `t${POST}=${samples[POST]}`,
);

// No premature fade: count is unchanged right up until the settle threshold.
if (samples[PRE] !== samples[0]) {
  fail(`premature fade: t0=${samples[0]} -> t${PRE}=${samples[PRE]} (before settle)`);
}
ok(`no premature fade: debris held at ${samples[0]} until t${PRE} (< settle)`);

// Ages out: after the settle window the count has DECREASED.
if (!(samples[POST] < samples[0])) {
  fail(`debris did not age out: t0=${samples[0]} -> t${POST}=${samples[POST]}`);
}
ok(`old debris ages out: ${samples[0]} -> ${samples[POST]} (decreased after settle)`);

// Terrain untouched by the trickle.
const floorStoneAfter = countMat(STONE);
if (floorStoneAfter !== floorStoneBefore) {
  fail(`terrain changed by trickle: STONE ${floorStoneBefore} -> ${floorStoneAfter}`);
}
let belowFloor = 0;
for (let y = GFLOOR + 1; y < WORLD_H; y++) {
  for (let x = 0; x < WORLD_W; x++) if (isLooseDebris(material[idx(x, y)])) belowFloor++;
}
if (belowFloor > 0) fail(`${belowFloor} debris cells tunnelled below the floor`);
ok(`terrain safe: STONE unchanged (${floorStoneAfter}) + no tunnelling`);

console.log('\nALL PASS');
console.log(
  `SUMMARY: THROTTLE=${BODY_LOD_THROTTLE} idleRuns≈${idleSurvRuns}/${N} ` +
    `onScreen=${onScreenRuns}/${N} pursuing=${pursueRuns}/${N} legLoss@t${legLossTick} ` +
    `gore ${samples[0]}->${samples[POST]} (settle=${GORE_SETTLE_TICKS}, ` +
    `ageFade=${GORE_AGE_FADE_PER_TICK}/tick)`,
);
