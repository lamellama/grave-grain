declare const process: any;
/**
 * r8-weather.test.ts - playtest v0.10 round 8, weather balance (GDD 10).
 *
 * The round-8 complaints: rain "completely floods within a few seconds and
 * everyone drowns"; snow buries everyone (including zombies), then the melt
 * floods; a wet campfire doesn't care. The rebalance: ~8x lighter rain with a
 * per-column pool cap; clear-weather evaporation as the drainage valve; a
 * per-column snowpack depth cap; melt that mostly yields AIR (fluffy snow);
 * WATER contact douses a campfire to ash.
 *
 * Done-when:
 *   1. RAIN IS SURVIVABLE - a survivor standing on open flat ground through a
 *      LONG pinned rain never drowns; standing water on its column stays a
 *      shallow pool (<= RAIN_MAX_POOL_DEPTH + slack).
 *   2. EVAPORATION DRAINS - a sky-exposed puddle fully evaporates during a
 *      pinned clear spell; a ROOFED pool does not (the sky can't see it).
 *   3. SNOW NEVER BURIES - through a LONG pinned snow spell the snowpack on
 *      flat ground stays <= SNOW_MAX_DEPTH + slack and a standing survivor's
 *      head is never covered.
 *   4. THAW, NOT FLOOD - a deep snowpack melting under pinned clear yields
 *      only a fraction of its cells as water (never a 1:1 flood).
 *   5. WET CAMPFIRE DIES - water touching a burning campfire kills it to ASH;
 *      a dry control campfire keeps burning.
 */

import {
  WORLD_W,
  WORLD_H,
  DROWN_TICKS,
  RAIN_MAX_POOL_DEPTH,
  SNOW_MAX_DEPTH,
  SNOW_MELT_WATER_FRACTION,
  NEED_MAX,
} from '../src/config';
import { STONE, WATER, SNOW, WOOD, ASH, AIR, CAMPFIRE } from '../src/engine/materials';
import { material, integrity, set, get, placeMaterial } from '../src/engine/grid';
import { rebuildNavgrid } from '../src/engine/navgrid';
import * as sim from '../src/engine/simulation';
import { __setWeatherForTest } from '../src/engine/weather';
import { createSurvivor } from '../src/characters/survivor';
import { updateBody } from '../src/characters/locomotion';

let failures = 0;
function check(cond: boolean, msg: string): void {
  console.log((cond ? 'PASS: ' : 'FAIL: ') + msg);
  if (!cond) failures++;
}

const FLOOR = 150;
const FEET = FLOOR - 1;

function flatWorld(): void {
  material.fill(AIR);
  integrity.fill(0);
  for (let x = 0; x < WORLD_W; x++) set(x, FLOOR, STONE);
  rebuildNavgrid();
}

function count(mat: number): number {
  let n = 0;
  for (let i = 0; i < material.length; i++) if (material[i] === mat) n++;
  return n;
}

/** Deepest contiguous run of `mat` directly above the floor, over [x0,x1]. */
function maxDepthOnFloor(mat: number, x0: number, x1: number): number {
  let best = 0;
  for (let x = x0; x <= x1; x++) {
    let d = 0;
    for (let y = FLOOR - 1; y >= 0 && get(x, y) === mat; y--) d++;
    if (d > best) best = d;
  }
  return best;
}

sim.setChunkingEnabled(false);

// ===========================================================================
// 1. RAIN IS SURVIVABLE on open ground.
// ===========================================================================
console.log('\n=== 1 long rain: shallow pools, nobody drowns ===');
{
  flatWorld();
  __setWeatherForTest('rain');
  const s = createSurvivor(640, FEET);
  let maxDrown = 0;
  for (let t = 0; t < DROWN_TICKS * 20; t++) {
    sim.step();
    s.needs.hunger = NEED_MAX;
    s.needs.thirst = NEED_MAX;
    s.needs.warmth = NEED_MAX;
    updateBody(s.body); // body physics only - isolate the weather question
    maxDrown = Math.max(maxDrown, s.body.drownTicks);
  }
  check(s.body.alive, `survivor alive after ${DROWN_TICKS * 20} ticks of rain`);
  check(maxDrown < DROWN_TICKS / 2, `drown clock never threatened (max ${maxDrown})`);
  // The physical claim is BOUNDED VOLUME: the per-column cap holds the world's
  // standing water near cap x columns (transient local depth wobbles a few
  // cells with waves and in-flight drops - that noise is fine, the body is 12
  // tall and floats). Pre-fix this was ~38 unbounded cells/tick.
  const volume = count(WATER);
  check(
    volume <= RAIN_MAX_POOL_DEPTH * WORLD_W * 1.5,
    `standing water volume bounded by the pool cap (${volume} <= ${RAIN_MAX_POOL_DEPTH * WORLD_W * 1.5})`,
  );
  const depth = maxDepthOnFloor(WATER, 600, 680);
  check(
    depth <= RAIN_MAX_POOL_DEPTH + 5,
    `local pool depth stays far below body height (deepest ${depth} <= ${RAIN_MAX_POOL_DEPTH + 5})`,
  );
}

// ===========================================================================
// 2. EVAPORATION drains sky-exposed water; roofed water is safe.
// ===========================================================================
console.log('\n=== 2 clear spell evaporates the flood (but not roofed pools) ===');
{
  flatWorld();
  __setWeatherForTest('clear');
  // An exposed CONTAINED puddle (stone basin walls so it can't slosh away -
  // only evaporation may remove it)...
  for (let y = FLOOR - 3; y < FLOOR; y++) {
    set(399, y, STONE);
    set(420, y, STONE);
  }
  for (let y = FLOOR - 2; y < FLOOR; y++)
    for (let x = 400; x < 420; x++) set(x, y, WATER);
  // ...and a fully-ENCLOSED roofed pool nearby (walls up to a WOOD lid).
  for (let y = FLOOR - 3; y < FLOOR; y++) {
    set(499, y, STONE);
    set(520, y, STONE);
  }
  for (let x = 499; x <= 520; x++) set(x, FLOOR - 3, WOOD);
  for (let y = FLOOR - 2; y < FLOOR; y++)
    for (let x = 500; x < 520; x++) set(x, y, WATER);

  const exposed0 = 40;
  let exposedGone = -1;
  for (let t = 0; t < 60000 && exposedGone < 0; t++) {
    sim.step();
    if (maxDepthOnFloor(WATER, 398, 421) === 0) exposedGone = t;
  }
  check(exposedGone >= 0, `exposed ${exposed0}-cell puddle fully evaporated (tick ${exposedGone})`);
  let roofed = 0;
  for (let y = FLOOR - 2; y < FLOOR; y++)
    for (let x = 500; x < 520; x++) if (get(x, y) === WATER) roofed++;
  check(roofed === 40, `roofed pool untouched (${roofed}/40 cells remain)`);
}

// ===========================================================================
// 3. SNOW NEVER BURIES - depth-capped snowpack.
// ===========================================================================
console.log('\n=== 3 long snow: knee-deep blanket, nobody buried ===');
{
  flatWorld();
  __setWeatherForTest('snow');
  const s = createSurvivor(640, FEET);
  let headBuried = 0;
  for (let t = 0; t < 12000; t++) {
    sim.step();
    s.needs.hunger = NEED_MAX;
    s.needs.thirst = NEED_MAX;
    s.needs.warmth = NEED_MAX;
    updateBody(s.body);
    if (t % 100 === 0) {
      // Head row (10 above the feet): buried iff snow sits at head height.
      const hx = Math.round(s.body.x);
      const hy = Math.round(s.body.y) - 10;
      if (get(hx, hy) === SNOW) headBuried++;
    }
  }
  const depth = maxDepthOnFloor(SNOW, 500, 780);
  check(
    depth <= SNOW_MAX_DEPTH + 2,
    `snowpack depth capped (deepest ${depth} <= ${SNOW_MAX_DEPTH + 2})`,
  );
  check(headBuried === 0, 'survivor head never buried in snow');
  check(s.body.alive, 'survivor alive through the whole spell');
}

// ===========================================================================
// 4. THAW, NOT FLOOD - melt yields only a fraction of water.
// ===========================================================================
console.log('\n=== 4 melt yields a damp thaw, not a flood ===');
{
  flatWorld();
  __setWeatherForTest('clear'); // above freezing -> ambient melt runs
  const snow0 = 6 * 100;
  for (let y = FLOOR - 6; y < FLOOR; y++)
    for (let x = 300; x < 400; x++) set(x, y, SNOW);
  let maxWater = 0;
  let snowGone = -1;
  for (let t = 0; t < 20000 && snowGone < 0; t++) {
    sim.step();
    maxWater = Math.max(maxWater, count(WATER));
    if (count(SNOW) === 0) snowGone = t;
  }
  check(snowGone >= 0, `the ${snow0}-cell snowpack fully melted (tick ${snowGone})`);
  check(
    maxWater < snow0 * (SNOW_MELT_WATER_FRACTION + 0.15),
    `peak melt water ${maxWater} << snowpack ${snow0} (fraction ~${SNOW_MELT_WATER_FRACTION})`,
  );
}

// ===========================================================================
// 5. WET CAMPFIRE DIES; dry control keeps burning.
// ===========================================================================
console.log('\n=== 5 water kills a campfire; a dry one burns on ===');
{
  flatWorld();
  __setWeatherForTest('clear');
  placeMaterial(700, FEET, CAMPFIRE); // the victim
  placeMaterial(760, FEET, CAMPFIRE); // dry control
  for (let t = 0; t < 30; t++) sim.step(); // both alight and burning
  check(get(700, FEET) === CAMPFIRE && get(760, FEET) === CAMPFIRE, 'setup: both hearths burning');
  set(699, FEET, WATER); // flood water touches the first hearth
  let dousedAt = -1;
  for (let t = 0; t < 20 && dousedAt < 0; t++) {
    sim.step();
    if (get(700, FEET) === ASH) dousedAt = t;
  }
  check(dousedAt >= 0, `wet campfire doused to ASH (tick ${dousedAt})`);
  check(get(760, FEET) === CAMPFIRE, 'dry control campfire still burning');
}

console.log('\n' + (failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'));
process.exit(failures === 0 ? 0 : 1);
