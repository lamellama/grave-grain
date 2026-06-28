/**
 * Headless verification for VS-1/v0.8 playtest M - snow spawn rebalance
 * (simulation.applyWeather, GDD 10). Real modules. Run via tsc (commonjs) -> node.
 *
 * The old model seeded the WHOLE sky row every tick (a uniform burying curtain).
 * Snow now falls in drifting FLURRY BANDS, so it spawns in drips and drabs.
 *
 * Covers (M-1, spawn):
 *   1. Snow spawns ONLY inside flurry bands (gaps between bands stay clear).
 *   2. Coverage is sparse - a small fraction of the width, not a full curtain.
 *   3. Bands DRIFT over time (the spawned column set shifts tick to tick).
 */
import { WORLD_W, SNOW_BAND_WIDTH, SNOW_BAND_GAP, SNOW_DRIFT } from '../src/config';
import { SNOW, AIR } from '../src/engine/materials';
import { material, get } from '../src/engine/grid';
import { step } from '../src/engine/simulation';
import { __setWeatherForTest } from '../src/engine/weather';

let failures = 0;
function check(cond: boolean, msg: string): void {
  console.log((cond ? 'PASS: ' : 'FAIL: ') + msg);
  if (!cond) failures++;
}

const PERIOD = SNOW_BAND_WIDTH + SNOW_BAND_GAP;

/** Columns holding SNOW anywhere in the top `rows` rows. */
function snowColumns(rows: number): number[] {
  const cols: number[] = [];
  for (let x = 0; x < WORLD_W; x++) {
    for (let y = 0; y < rows; y++) {
      if (get(x, y) === SNOW) {
        cols.push(x);
        break;
      }
    }
  }
  return cols;
}

// Fresh module load => tick starts at 0; pin snow so applyWeather seeds snow.
__setWeatherForTest('snow');
material.fill(AIR); // empty world: spawned snow falls a row, nothing to bury

// ---------------------------------------------------------------------------
// One step at tick 0 (drift shift = 0): snow spawns at row 0 and falls to row 1.
// Every spawned column must lie INSIDE a band: (x % PERIOD) < SNOW_BAND_WIDTH.
// ---------------------------------------------------------------------------
step(); // processes tick 0, then tick -> 1
const cols0 = snowColumns(4);
check(cols0.length > 0, '1: snow spawned (drips present)');
const allInBand = cols0.every((x) => x % PERIOD < SNOW_BAND_WIDTH);
check(allInBand, '1: every snow column lies inside a flurry band (gaps stay clear)');

// Coverage is sparse - nowhere near a full-width curtain.
const coverage = cols0.length / WORLD_W;
check(coverage < 0.1, `2: snow coverage is sparse (${(coverage * 100).toFixed(1)}% of width, drips not a curtain)`);
// And the gaps are real: with band duty ~WIDTH/PERIOD, most columns are clear.
const bandDuty = SNOW_BAND_WIDTH / PERIOD;
check(coverage <= bandDuty + 0.02, `2: coverage within band duty (~${(bandDuty * 100).toFixed(0)}%)`);

// ---------------------------------------------------------------------------
// 3. Bands DRIFT: after enough ticks for the drift to move a band by > a band
//    width, the in-band column set shifts (snow appears in columns that were in
//    a GAP at tick 0). Run until shift exceeds one band period.
// ---------------------------------------------------------------------------
{
  // ticks needed for the band pattern to drift a full period (so gap<->band swap)
  const ticks = Math.ceil(PERIOD / SNOW_DRIFT) + 2;
  let sawShiftedColumn = false;
  for (let t = 0; t < ticks; t++) {
    material.fill(AIR);
    step();
    const cols = snowColumns(4);
    // a column that is in a GAP under the tick-0 mask but now has snow => drift.
    if (cols.some((x) => x % PERIOD >= SNOW_BAND_WIDTH)) {
      sawShiftedColumn = true;
      break;
    }
  }
  check(sawShiftedColumn, '3: flurry bands drift over time (snow reaches tick-0 gap columns)');
}

// ===========================================================================
// M-2: AMBIENT MELT. A snowpack laid down cold must RECEDE once it warms, and
// the chunked melt must stay byte-identical to the full scan (the hard part:
// settled snow has no local active neighbour, so step() wakes it on the warm
// edge). Uses fresh module graphs so chunking OFF vs ON run independently.
// ===========================================================================
declare const require: {
  (m: string): any;
  cache: Record<string, unknown>;
};

function freshSim() {
  for (const k of Object.keys(require.cache)) {
    if (k.indexOf('.test-out') !== -1) delete require.cache[k];
  }
  const cfg = require('../src/config');
  const grid = require('../src/engine/grid');
  const mats = require('../src/engine/materials');
  const sim = require('../src/engine/simulation');
  const weather = require('../src/engine/weather');
  return { cfg, grid, mats, sim, weather };
}
type Sim = ReturnType<typeof freshSim>;

function countMat(s: Sim, m: number): number {
  let n = 0;
  const a = s.grid.material;
  for (let i = 0; i < a.length; i++) if (a[i] === m) n++;
  return n;
}
function snapshot(s: Sim): Uint8Array {
  const n = s.grid.material.length;
  const snap = new Uint8Array(n * 2);
  snap.set(s.grid.material, 0);
  snap.set(s.grid.integrity, n);
  return snap;
}

const ACCUM = 400; // ticks of snowfall (cold)
const MELT = 800; // ticks after warming

/** Accumulate snow cold, then warm and melt. Returns final grid + counts. */
function meltScenario(chunking: boolean): {
  snap: Uint8Array;
  accum: number;
  after: number;
  water: number;
} {
  const s = freshSim();
  s.sim.setChunkingEnabled(chunking);
  // Full-width stone floor at row 120, open sky above.
  const FLOOR_Y = 120;
  for (let x = 0; x < s.cfg.WORLD_W; x++) s.grid.set(x, FLOOR_Y, s.mats.STONE);
  s.weather.__setWeatherForTest('snow');
  for (let t = 0; t < ACCUM; t++) s.sim.step();
  const accum = countMat(s, s.mats.SNOW);
  s.weather.__setWeatherForTest('clear'); // warm -> ambient melt begins
  for (let t = 0; t < MELT; t++) s.sim.step();
  return {
    snap: snapshot(s),
    accum,
    after: countMat(s, s.mats.SNOW),
    water: countMat(s, s.mats.WATER),
  };
}

const full = meltScenario(false); // reference
const chunked = meltScenario(true);

check(full.accum > 0, `M2: snow accumulated while cold (${full.accum} cells)`);
check(
  full.after < full.accum * 0.1,
  `M2: snowpack melted away after warming (${full.accum} -> ${full.after})`,
);
check(full.water > 0, `M2: melt produced WATER (${full.water} cells)`);

// THE chunk-safety bar: chunked melt == full-scan melt, byte for byte.
let firstDiff = -1;
if (full.snap.length !== chunked.snap.length) firstDiff = 0;
else
  for (let i = 0; i < full.snap.length; i++)
    if (full.snap[i] !== chunked.snap[i]) {
      firstDiff = i;
      break;
    }
check(firstDiff === -1, 'M2: chunked melt is BYTE-IDENTICAL to the full scan');
check(
  chunked.after === full.after && chunked.water === full.water,
  `M2: chunked counts match full (snow ${chunked.after}/${full.after}, water ${chunked.water}/${full.water})`,
);

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
if (failures > 0) throw new Error('weather-snow assertions failed');
console.log(
  'SUMMARY: snow spawns only inside drifting flurry bands (gaps stay clear); coverage is sparse (drips/drabs, not a burying curtain); bands drift; and a snowpack MELTS once it warms above SNOW_MELT_TEMP - chunked melt byte-identical to the full scan.',
);
