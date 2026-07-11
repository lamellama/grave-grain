declare const require: any; declare const process: any;
/**
 * vs3-t5-mainloop.test.ts - VS-3 T5: main-loop integration + seekWarmth-to-
 * group-shelter + the phase-level cooperative-camp e2e (GDD 6.2/8/6.1).
 *
 * Done-when:
 *   A. LIVE MAIN PATH - the REAL main.ts (stubbed DOM, driven rAF, same harness
 *      as main-smoke) wires grouping + cooperative building into its tick:
 *      after a few recheck periods the spawn cluster is grouped, owns a shelter
 *      project, and project cells are streaming into the blueprint queue
 *      (capped) - all through main.ts's own simulationTick, no direct calls.
 *   B1. PHASE E2E (cold-start camp, main tick order) - a group of 2 builders +
 *      2 civilians plans its hut, the builders raise it to FULL enclose, the
 *      campfire is queued+lit on enclose, and when the cold snap comes the
 *      civilians (inside) recover warmth above threshold - nobody freezes.
 *   B2. SEEKWARMTH TARGETS THE GROUP'S SHELTER - a cold group member OUTSIDE the
 *      built hut walks IN through the doorway and recovers, even though a
 *      FOREIGN roof (canopy) is strictly nearer in the other direction: the
 *      group's own hut wins (VS-3 cohesion; pre-T5 behaviour picked the canopy).
 */

import {
  WORLD_W,
  P3_GROUND_Y,
  NEED_MAX,
  WARMTH_THRESHOLD,
  GROUP_RECHECK_TICKS,
  MAX_BUILD_CLAIMS,
  SIM_HZ,
  BODY_H,
} from '../src/config';
import { STONE, AIR, WALL, WOOD, DOOR, CAMPFIRE } from '../src/engine/materials';
import { material, integrity, set, get } from '../src/engine/grid';
import { rebuildNavgrid } from '../src/engine/navgrid';
import * as simulation from '../src/engine/simulation';
import { __setWeatherForTest } from '../src/engine/weather';
import {
  createSurvivor,
  updateSurvivor,
  isSheltered,
  type Survivor,
} from '../src/characters/survivor';
import { makeTool } from '../src/game/roles';
import { addResource, resetStockpile } from '../src/game/resources';
import { resetQueue, getBlueprints } from '../src/game/buildqueue';
import { updateGroups, resetGroups, groupIds } from '../src/game/groups';
import {
  getShelterProject,
  ensureShelterProject,
  resetShelters,
} from '../src/game/shelter';
import {
  updateCoopBuild,
  shellComplete,
  queuedCellCount,
} from '../src/game/coopbuild';
import { resetCampFlag, plantCampFlagAt } from '../src/game/camp';
import { placePrefabAt, prefabCost, getHutVersion } from '../src/game/prefabs';

let failures = 0;
function check(cond: boolean, msg: string): void {
  console.log((cond ? 'PASS: ' : 'FAIL: ') + msg);
  if (!cond) failures++;
}
function label(name: string): void {
  console.log('\n=== ' + name + ' ===');
}

// ===========================================================================
// A. LIVE MAIN PATH - real main.ts under stubbed DOM, rAF driven by hand.
//    (Stub harness mirrors main-smoke.test.ts; performance.now is controlled
//    so the fixed-timestep accumulator runs exactly one sim tick per frame.)
// ===========================================================================
label('A live main path: groups + coop-build wired into simulationTick');

function fakeCtx(): any {
  return {
    fillStyle: '#000', font: '', textAlign: 'left', globalAlpha: 1,
    strokeStyle: '#000', lineWidth: 1,
    save() {}, restore() {}, scale() {}, beginPath() {}, rect() {},
    moveTo() {}, lineTo() {}, stroke() {}, setLineDash() {},
    fillRect() {}, strokeRect() {}, clearRect() {},
    fillText() {},
    createImageData(w: number, h: number) {
      return { data: new Uint8ClampedArray(Math.max(1, w * h * 4)), width: w, height: h };
    },
    putImageData() {},
    measureText() { return { width: 0 }; },
  };
}
function fakeEl(): any {
  return {
    width: 0, height: 0, style: {}, dataset: {},
    getContext() { return fakeCtx(); },
    getBoundingClientRect() {
      return { width: 1280, height: 720, left: 0, top: 0, right: 1280, bottom: 720 };
    },
    addEventListener() {}, removeEventListener() {},
    setAttribute() {}, getAttribute() { return null; },
    classList: { add() {}, remove() {}, toggle() {} },
    appendChild() {}, querySelector() { return null; },
    textContent: '',
  };
}

let fakeTime = 0;
// `any` (not a narrowed union): TS can't see the assignment inside the rAF stub.
let rafCb: any = null;
const g: any = globalThis;
g.devicePixelRatio = 1;
g.requestAnimationFrame = (fn: () => void) => { rafCb = fn; return 1; };
g.cancelAnimationFrame = () => {};
g.performance = { now: () => fakeTime };
g.window = g;
g.document = {
  getElementById() { return fakeEl(); },
  querySelector() { return fakeEl(); },
  querySelectorAll() { return [] as any; },
  createElement() { return fakeEl(); },
  addEventListener() {}, removeEventListener() {},
  body: fakeEl(),
};
g.addEventListener = () => {};

let threw: any = null;
try {
  require('../src/main');
} catch (e) {
  threw = e;
}
check(!threw, 'main.ts bootstraps with the T5 wiring (no throw)' + (threw ? ' - ' + (threw.message || threw) : ''));
check(rafCb !== null, 'main started the render loop');

// ROUND 11: the camp flag is retired and survivors NEVER plan their own camp
// on the live path (updateCoopBuild is no longer wired into simulationTick -
// "leaving the survivors to create their own camp is not working"). The
// player designates camp by BUYING A HUT (game/prefabs.ts). Section A now
// locks in: grouping still runs live; NO shelter project / blueprint ever
// appears autonomously; and a hut purchase works on the live world.

// Drive enough frames for two full recheck periods (1 sim tick per frame).
const FRAMES = GROUP_RECHECK_TICKS * 2 + 5;
for (let f = 0; f < FRAMES && rafCb; f++) {
  fakeTime += 1000 / SIM_HZ;
  const cb = rafCb;
  rafCb = null;
  cb();
}

const liveGroups = groupIds();
check(liveGroups.length >= 1, `spawn cluster grouped on the live path (${liveGroups.length} group(s))`);
{
  let liveProjects = 0;
  for (const gid of liveGroups) {
    if (getShelterProject(gid)) liveProjects++;
  }
  check(
    liveProjects === 0,
    'NO autonomous shelter project on the live path (round 11: coop camp retired)',
  );
  check(
    getBlueprints().length === 0,
    'the blueprint queue stays EMPTY (nothing streamed autonomously)',
  );
}
{
  // The round-11 replacement: buying a hut on the live generated world works
  // end to end (the tap snaps to the real surface just right of the spawn
  // cluster - WORLDGEN_SEED is fixed, 950 is open ground) and bumps the hut
  // version main watches to re-home the colony.
  const hv0 = getHutVersion();
  const hc = prefabCost('hut');
  addResource('wood', hc.wood ?? 0);
  addResource('stone', hc.stone ?? 0);
  check(placePrefabAt('hut', 950, 0), 'a hut purchase succeeds on the live world');
  check(getHutVersion() === hv0 + 1, 'the hut version bumped (main re-homes the colony off this)');
  // A few more live frames: the loop keeps ticking with the hut placed (the
  // re-home branch, spike pass and arrow pass all execute without throwing).
  let liveThrew: any = null;
  try {
    for (let f = 0; f < 5 && rafCb; f++) {
      fakeTime += 1000 / SIM_HZ;
      const cb = rafCb;
      rafCb = null;
      cb();
    }
  } catch (e) {
    liveThrew = e;
  }
  check(
    !liveThrew,
    'the live loop keeps ticking after the purchase' +
      (liveThrew ? ' - ' + (liveThrew.message || liveThrew) : ''),
  );
  check(getBlueprints().length === 0, 'still no autonomous blueprints after the purchase');
}

// ===========================================================================
// Shared scene helpers for the controlled phases (B1/B2).
// ===========================================================================
const FLOOR = P3_GROUND_Y;
const FEET = FLOOR - 1;

function resetWorld(): void {
  material.fill(AIR);
  integrity.fill(0);
  for (let x = 0; x < WORLD_W; x++) set(x, FLOOR, STONE);
  rebuildNavgrid();
  resetQueue();
  resetShelters();
  resetGroups();
  resetStockpile();
  // R9: drop the previous block's camp flag. B1 plants its own; B2 runs
  // flagless (its project is planned directly via ensureShelterProject, and a
  // leftover flag would make updateCoopBuild abandon that version-0 project).
  resetCampFlag();
}

function asBuilder(s: Survivor): Survivor {
  s.role = 'builder';
  s.tool = makeTool('hammer');
  s.roleState = 'toTarget';
  return s;
}

let simTick = 0;

/**
 * One tick in main.ts's per-tick ORDER for this slice: simulation.step ->
 * updateSurvivor each -> updateGroups (self-gated) -> updateCoopBuild on the
 * SAME recheck cadence main uses. Needs are topped per the caller's maps so the
 * phase under test (building, or the cold snap) is isolated.
 */
function mainTick(
  survs: Survivor[],
  opts: { topWarmth: Set<Survivor>; park: Set<Survivor>; sim?: boolean },
): void {
  // B2 runs on a STATIC grid (sim: false): pinned-snow sky-spawn would pile
  // snow cells along a drift pattern tied to the GLOBAL sim tick - which varies
  // run-to-run with B1's Math.random wander - and a drift landing in the hut
  // doorway flakes the walk-home path. The seek under test never needs the CA.
  if (opts.sim !== false) simulation.step();
  for (const s of survs) {
    s.needs.hunger = NEED_MAX;
    s.needs.thirst = NEED_MAX;
    if (opts.topWarmth.has(s)) s.needs.warmth = NEED_MAX;
    if (opts.park.has(s)) s.pauseTicks = 5; // deterministic stand-still (no RNG walk)
    if (s.role === 'builder' && s.tool) s.tool.durability = 999;
  }
  for (const s of survs) updateSurvivor(s, []);
  updateGroups(survs, simTick);
  if (simTick % GROUP_RECHECK_TICKS === 0) updateCoopBuild(survs);
  simTick++;
}

// ===========================================================================
// B1. PHASE E2E - cold-start camp: plan -> cooperative build -> enclose ->
//     campfire -> cold snap -> civilians recover inside. Main tick order.
// ===========================================================================
label('B1 phase e2e: plan -> build -> enclose -> campfire -> recover');
{
  resetWorld();
  plantCampFlagAt(301, FEET); // R9: the player sites the camp with the flag
  simTick = 0;
  __setWeatherForTest('clear'); // mild while the hut goes up (isolates building)
  addResource('wood', 500);
  addResource('stone', 500);

  const b0 = asBuilder(createSurvivor(300, FEET));
  const b1 = asBuilder(createSurvivor(302, FEET));
  const c0 = createSurvivor(299, FEET);
  const c1 = createSurvivor(303, FEET);
  const survs = [b0, b1, c0, c1];
  const topAll = new Set(survs);
  const parkCivs = new Set([c0, c1]);

  // First recheck: one co-located group; coop-build plans + streams.
  mainTick(survs, { topWarmth: topAll, park: parkCivs });
  check(groupIds().length === 1, 'B1: the four co-located survivors form ONE group');
  const gid = groupIds()[0];
  const project = getShelterProject(gid);
  check(project !== null, 'B1: the group owns a shelter project after the first cadence');

  if (project) {
    check(project.cells.length > 20, `B1: project is a real hut (${project.cells.length} cells)`);
    const q = queuedCellCount(project);
    check(q > 0 && q <= MAX_BUILD_CLAIMS, `B1: stream cap holds (${q} queued <= ${MAX_BUILD_CLAIMS})`);

    // Builders raise the hut to FULL enclose through the live order.
    let encloseTick = -1;
    for (let t = 0; t < 60000; t++) {
      mainTick(survs, { topWarmth: topAll, park: parkCivs });
      if (shellComplete(project)) { encloseTick = simTick; break; }
    }
    check(encloseTick >= 0, `B1: hut fully encloses via the main tick order (tick ${encloseTick})`);

    // Campfire queued on enclose, then built by a builder.
    let fireTick = -1;
    for (let t = 0; t < 20000; t++) {
      mainTick(survs, { topWarmth: topAll, park: parkCivs });
      if (get(project.campfire.x, project.campfire.y) === CAMPFIRE) { fireTick = simTick; break; }
    }
    check(fireTick >= 0, `B1: campfire lit on the interior floor after enclose (tick ${fireTick})`);

    // COLD SNAP: snow rolls in; the civilians (parked inside the new hut) go
    // cold, then recover ABOVE threshold under their roof - nobody freezes.
    __setWeatherForTest('snow');
    c0.needs.warmth = WARMTH_THRESHOLD - 5;
    c1.needs.warmth = WARMTH_THRESHOLD - 5;
    const topBuilders = new Set([b0, b1]);
    let recovered = -1;
    for (let t = 0; t < 4000; t++) {
      mainTick(survs, { topWarmth: topBuilders, park: new Set() });
      if (
        c0.needs.warmth > WARMTH_THRESHOLD &&
        c1.needs.warmth > WARMTH_THRESHOLD
      ) { recovered = t; break; }
    }
    check(recovered >= 0, `B1: both civilians recovered warmth above threshold (${recovered} ticks into the snap)`);
    check(c0.body.alive && c1.body.alive, 'B1: nobody froze in the cold snap');
    check(isSheltered(c0.body) && isSheltered(c1.body), 'B1: civilians are sheltered inside the group hut');
  }
}

// ===========================================================================
// B2. SEEKWARMTH TARGETS THE GROUP'S SHELTER - even over a NEARER foreign roof.
// ===========================================================================
label('B2 seekWarmth walks home: own hut beats a nearer foreign canopy');
{
  resetWorld();
  simTick = 0;
  __setWeatherForTest('snow');

  const m0 = createSurvivor(330, FEET);
  const m1 = createSurvivor(332, FEET);
  const cold = createSurvivor(352, FEET);
  const survs = [m0, m1, cold];

  // Group them on the OPEN floor first (line of sight everywhere), so the
  // edges are ON before the hut walls block sight (split then debounces).
  updateGroups(survs, 0);
  check(groupIds().length === 1, 'B2: all three grouped before the hut goes up');
  const gid = groupIds()[0];
  check(cold.groupId === gid, 'B2: groupId is STAMPED on the survivor (T5 wiring)');

  // Plan the group hut, then raise it instantly (this test proves the SEEK, not
  // the build). Doorway is on the RIGHT wall - facing the cold straggler.
  const project = ensureShelterProject(gid, [0, 1, 2], survs);
  check(project !== null, 'B2: group shelter project planned');
  if (project) {
    for (const c of project.cells) set(c.x, c.y, c.kind === 'wall' ? WALL : c.kind === 'door' ? DOOR : WOOD);
    rebuildNavgrid();

    const leftIn = project.campfire.x; // leftmost interior column
    const rightIn = leftIn + project.iw - 1; // rightmost interior column

    // FOREIGN canopy: a sheltering WOOD strip on the straggler's FAR side,
    // strictly NEARER to it than the hut interior. Pre-T5 seekWarmth (nearest
    // sheltered stand-cell) picks this; T5 must walk HOME instead.
    const canopyX0 = 358;
    const canopyX1 = 366;
    const canopyY = FEET - (BODY_H + 1); // 2 above a standing head - in roof scan
    for (let x = canopyX0; x <= canopyX1; x++) set(x, canopyY, WOOD);
    rebuildNavgrid();
    const distHome = Math.abs(rightIn - 352);
    const distCanopy = Math.abs(canopyX0 - 352);
    check(distCanopy < distHome, `B2: canopy is strictly nearer (${distCanopy} < ${distHome} cells)`);

    // The straggler is cold; the others stay warm + parked.
    cold.needs.warmth = WARMTH_THRESHOLD - 10;
    const topOthers = new Set([m0, m1]);
    const parkOthers = new Set([m0, m1]);
    let arrived = -1;
    for (let t = 0; t < 3000; t++) {
      mainTick(survs, { topWarmth: topOthers, park: parkOthers, sim: false });
      const x = Math.round(cold.body.x);
      if (x >= leftIn && x <= rightIn && isSheltered(cold.body)) { arrived = t; break; }
    }
    check(arrived >= 0, `B2: cold straggler entered the GROUP's hut through the doorway (tick ${arrived})`);
    const cx = Math.round(cold.body.x);
    check(cx < canopyX0, `B2: it went HOME (x=${cx}), not to the nearer foreign canopy (x>=${canopyX0})`);

    // And it recovers there.
    let recovered = -1;
    for (let t = 0; t < 2000; t++) {
      mainTick(survs, { topWarmth: topOthers, park: parkOthers, sim: false });
      if (cold.needs.warmth > WARMTH_THRESHOLD) { recovered = t; break; }
    }
    check(recovered >= 0, 'B2: straggler recovered warmth above threshold at home');
    check(cold.body.alive, 'B2: straggler never froze');
  }
}

console.log('\n' + (failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'));
process.exit(failures === 0 ? 0 : 1);
