declare const require: any;
/**
 * Headless verification for the OPEN-CAMP fix — THE KEY warm-AND-can-leave test
 * (GDD §8 shelter = warmth + retreat, §6.1 needs, §10 ambient cold). A survivor
 * must live under a ROOF (open sides) on the cold world AND freely walk OUT for
 * water — closing the design flaw where a walled box sealed a warm colony in to
 * die of THIRST. Real modules (generateWorld + rebuildNavgrid + the live sim
 * drivers); no mocks. tsc (commonjs) → node.
 *
 * Scene: a COLD generated world. One survivor spawned AT the camp shelterPoint.
 *   - It starts isSheltered and warm.
 *   - Thirst is dropped below threshold → it auto-overrides to seekWater, paths
 *     OUT from under the canopy to the reachable pond, and DRINKS (thirst rises).
 *   - Away from the roof it cools; when warmth drops it returns UNDER the roof to
 *     warm back up (seekWarmth / wander-near-home).
 *   - Over a long run (12000 ticks) it manages BOTH needs: never dies of thirst,
 *     never freezes, ends ALIVE. Hunger is pinned full to isolate thirst+warmth.
 *
 * Asserts: reached water (thirst recovered) AND left the canopy (not sealed) AND
 * returned under the roof (warmth recovered) AND alive at the end.
 */
import {
  createSurvivor,
  updateSurvivor,
  isSheltered,
} from '../src/characters/survivor';
import { rebuildNavgrid } from '../src/engine/navgrid';
import { generateWorld } from '../src/game/worldgen';
import {
  WORLDGEN_SEED,
  NEED_MAX,
  THIRST_THRESHOLD,
  WARMTH_THRESHOLD,
} from '../src/config';

declare const process: any;

let failures = 0;
function check(cond: boolean, msg: string): void {
  console.log((cond ? 'PASS: ' : 'FAIL: ') + msg);
  if (!cond) failures++;
}

console.log('=== Open-camp flow: warm under a roof AND can leave for water ===');

const res = generateWorld(WORLDGEN_SEED);
rebuildNavgrid();
console.log(
  `  spawnX=${res.spawnX} shelterPoint=(${res.shelterPoint.x},${res.shelterPoint.y}) zombieEdge=${res.zombieEdge}`,
);

const s = createSurvivor(res.shelterPoint.x, res.shelterPoint.y);

// Settle one tick, confirm it starts sheltered & warm under the roof.
s.needs.hunger = NEED_MAX;
updateSurvivor(s, []);
const shelteredAtStart = isSheltered(s.body);
check(shelteredAtStart, 'survivor spawned at the camp is sheltered (under the roof)');
check(s.needs.warmth > WARMTH_THRESHOLD, 'survivor starts warm under the roof');

// Drop thirst below threshold → it must leave for the pond.
s.needs.thirst = 20;

let everSoughtWater = false;
let drank = false; // a drink restored a big chunk of thirst
let leftCanopy = false; // walked out from under the roof (NOT sealed in)
let returnedUnderRoof = false; // came back under the roof to warm up
let warmthDipped = false; // cooled while away (warmth fell below threshold)
let thirstMin = s.needs.thirst;
let warmthMin = s.needs.warmth;
let prevThirst = s.needs.thirst;

let drinkCount = 0;
const TICKS = 12000;
for (let t = 0; t < TICKS && s.body.alive; t++) {
  s.needs.hunger = NEED_MAX; // isolate thirst + warmth
  updateSurvivor(s, []);

  if (s.behaviour === 'seekWater') everSoughtWater = true;
  if (s.needs.thirst > prevThirst + 5) { drank = true; drinkCount++; }
  prevThirst = s.needs.thirst;
  if (t % 1000 === 0 || (t >= 2400 && t <= 3800 && t % 200 === 0)) {
    const st: any = s.seekTarget;
    console.log(`  t=${t} x=${Math.round(s.body.x)} y=${Math.round(s.body.y)} dir=${s.body.moveDir} beh=${s.behaviour} thirst=${s.needs.thirst.toFixed(1)} path=${s.path ? s.path.waypoints.length : 'null'} seekTgt=${st ? `(${st.cell.x},${st.cell.y})` : 'null'} drinks=${drinkCount}`);
  }

  const sheltered = isSheltered(s.body);
  if (!sheltered) leftCanopy = true;
  if (sheltered && leftCanopy) returnedUnderRoof = true;
  if (s.needs.warmth < WARMTH_THRESHOLD) warmthDipped = true;

  thirstMin = Math.min(thirstMin, s.needs.thirst);
  warmthMin = Math.min(warmthMin, s.needs.warmth);
}

console.log(
  `  after ${TICKS} ticks: alive=${s.body.alive} | thirst min=${thirstMin.toFixed(1)} final=${s.needs.thirst.toFixed(1)} | ` +
    `warmth min=${warmthMin.toFixed(1)} final=${s.needs.warmth.toFixed(1)}`,
);
console.log(
  `  flags: soughtWater=${everSoughtWater} drank=${drank} leftCanopy=${leftCanopy} returnedUnderRoof=${returnedUnderRoof} warmthDipped=${warmthDipped} | deathCause=${s.deathCause}`,
);

check(everSoughtWater, 'thirsty survivor auto-overrode to seekWater');
check(leftCanopy, 'survivor walked OUT from under the roof (open camp — NOT sealed in)');
// Reached water and recovered: thirst was forced low (<threshold) and the
// survivor drank repeatedly over the run (each drink restores a big chunk). We
// assert the RECOVERY happened (drinkCount>=1) rather than the final instant,
// which can land mid-depletion in a 12000-tick run — the alive-at-end +
// warmth-managed asserts confirm sustained survival.
check(drank && drinkCount >= 1 && thirstMin < THIRST_THRESHOLD,
  'reached water: thirst dropped low then RECOVERED (drank at the pond)');
check(returnedUnderRoof, 'survivor returned UNDER the roof after drinking');
check(warmthMin > 0 && s.needs.warmth > WARMTH_THRESHOLD,
  'warmth managed: never hit 0, ended back above threshold (warmed under the roof)');
check(s.body.alive && s.deathCause === null,
  'ALIVE at the end — did NOT die of thirst NOR freeze (both needs managed)');

console.log('');
if (failures === 0) {
  console.log('ALL PASS');
  console.log(
    'SUMMARY: on a cold world the survivor lives under an OPEN-SIDED roof canopy, ' +
      'walks OUT to the pond to drink when thirsty, and returns under the roof to ' +
      'warm up — managing BOTH thirst and warmth over a long run without dying. ' +
      'The old walled box (which sealed the colony in to die of thirst) is fixed.',
  );
  process.exit(0);
} else {
  console.error(`\n${failures} FAILED`);
  process.exit(1);
}
