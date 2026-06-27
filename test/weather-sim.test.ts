/**
 * test/weather-sim.test.ts — Weather & Temperature T3 (GDD §10, Beyond).
 *
 * Wiring weather into the falling-sand sim must NOT weaken any of the three
 * load-bearing invariants. This test asserts over the REAL engine modules:
 *
 *  1. CHUNK BYTE-EQUIVALENCE under weather: the chunked / dirty-rect scan
 *     (chunking ON) produces output BYTE-IDENTICAL to the full grid scan
 *     (chunking OFF) through BOTH a forced RAIN phase and a forced SNOW phase,
 *     each with a live fire present (so the rain-douse AND snow-melt reactions
 *     are exercised on both paths). Diffed at ticks 50/150/300.
 *  2. RAIN fills water + douses fire faster: a lit wood block under open sky
 *     extinguishes in STRICTLY fewer ticks under rain than under clear, and
 *     WATER cells appear from the sky.
 *  3. SNOW accumulates + no-tunnel: under snow, SNOW mass grows over time and
 *     forms a stable pile; nothing tunnels through the stone floor.
 *
 * Mirrors test/p11-chunk-equiv.test.ts: fresh CommonJS module graph per run
 * (busts the require-cache) so tick, the grid arrays, the chunk bitsets and the
 * weather state all reset to tick-0.
 */

import '../src/engine/simulation';

declare const require: {
  (m: string): any;
  cache: Record<string, unknown>;
  resolve(m: string): string;
};
declare const process: any;

function fail(msg: string): never {
  console.log('FAIL:', msg);
  throw new Error(msg);
}
function ok(msg: string): void {
  console.log('PASS:', msg);
}

function freshSim() {
  for (const k of Object.keys(require.cache)) {
    if (k.indexOf('.test-out') !== -1) delete require.cache[k];
  }
  const config = require('../src/config');
  const grid = require('../src/engine/grid');
  const mats = require('../src/engine/materials');
  const chunks = require('../src/engine/chunks');
  const weather = require('../src/engine/weather');
  const sim = require('../src/engine/simulation');
  return { config, grid, mats, chunks, weather, sim };
}
type Sim = ReturnType<typeof freshSim>;

const W = freshSim().config.WORLD_W;
const H = freshSim().config.WORLD_H;

// ---------------------------------------------------------------------------
// Scene seeders. A STONE floor gives precipitation something to rest on and a
// no-tunnel reference row. A small WOOD block ignited on top sits under OPEN
// SKY (clear AIR column above it up to row 0) so rain/snow falls onto it.
// ---------------------------------------------------------------------------
const FLOOR_Y = 120;
const FLOOR_X0 = 0;
const FLOOR_X1 = W - 1;

const WOOD_X0 = 600;
const WOOD_X1 = 660;
const WOOD_TOP = 15; // wood top row (open sky above: rows 0..14 are AIR)
const WOOD_BOT = 60;

function floor(s: Sim): void {
  const { grid, mats } = s;
  grid.material.fill(0);
  grid.integrity.fill(0);
  for (let x = FLOOR_X0; x <= FLOOR_X1; x++) grid.set(x, FLOOR_Y, mats.STONE);
}

/** Floor + a lit wood block under open sky (top row ignited → spreads down). */
function seedLitWood(s: Sim): void {
  floor(s);
  const { grid, mats, sim } = s;
  for (let y = WOOD_TOP; y <= WOOD_BOT; y++)
    for (let x = WOOD_X0; x <= WOOD_X1; x++) grid.placeMaterial(x, y, mats.WOOD);
  for (let x = WOOD_X0; x <= WOOD_X1; x++) sim.ignite(x, WOOD_TOP);
}

// A wide, ONE-ROW WOOD slab under open sky (rows above it are AIR up to row 0),
// ignited only at its LEFT END, for the rain-douse test. A single row keeps the
// fire fully EXPOSED so sky-rain falls onto it (a solid multi-row block would
// shield its interior). Igniting only one end forces the fire to SPREAD across
// the slab over time: under CLEAR that lateral march burns the whole length
// (slow); under RAIN a water sheet builds on the slab top and both douses the
// fire and halts the march — so rain extinguishes far sooner. Douse is purely
// the normal water+fire reaction reaching exposed fire (no special rain nudge).
const SLAB_Y = 12;
const SLAB_X0 = 400;
const SLAB_X1 = 600;
function seedFireSlab(s: Sim): void {
  floor(s);
  const { grid, mats, sim } = s;
  for (let x = SLAB_X0; x <= SLAB_X1; x++) grid.placeMaterial(x, SLAB_Y, mats.WOOD);
  for (let x = SLAB_X0; x <= SLAB_X0 + 4; x++) sim.ignite(x, SLAB_Y); // left end only
}

function snapshot(s: Sim): Uint8Array {
  const n = s.grid.material.length;
  const snap = new Uint8Array(n * 2);
  snap.set(s.grid.material, 0);
  snap.set(s.grid.integrity, n);
  return snap;
}

function firstDiff(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length) return 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return i;
  return -1;
}

function countMat(s: Sim, m: number): number {
  let n = 0;
  const mat = s.grid.material;
  for (let i = 0; i < mat.length; i++) if (mat[i] === m) n++;
  return n;
}

function countFire(s: Sim): number {
  return countMat(s, s.mats.FIRE);
}

const CHECKPOINTS = [50, 150, 300];

/** Run the lit-wood scene under one chunking mode, pinned to `phase`. */
function runEquivScenario(
  phase: 'rain' | 'snow',
  chunking: boolean,
): Record<number, Uint8Array> {
  const s = freshSim();
  s.sim.setChunkingEnabled(chunking);
  seedLitWood(s);
  s.weather.__setWeatherForTest(phase); // FORCE + pin the phase for the run
  const out: Record<number, Uint8Array> = {};
  const last = CHECKPOINTS[CHECKPOINTS.length - 1];
  for (let t = 1; t <= last; t++) {
    s.sim.step();
    if (CHECKPOINTS.indexOf(t) !== -1) out[t] = snapshot(s);
  }
  return out;
}

// ===========================================================================
// 1. CHUNK BYTE-EQUIVALENCE under weather (rain phase AND snow phase).
// ===========================================================================
let allEqual = true;
for (const phase of ['rain', 'snow'] as const) {
  const ref = runEquivScenario(phase, false); // full-scan reference
  const chk = runEquivScenario(phase, true); // chunked
  let phaseEqual = true;
  for (const t of CHECKPOINTS) {
    const d = firstDiff(ref[t], chk[t]);
    if (d !== -1) {
      phaseEqual = false;
      allEqual = false;
      const n = ref[t].length / 2;
      const where = d < n ? `material[${d % W},${(d / W) | 0}]` : `integrity@${d - n}`;
      console.log(
        `  [${phase}] tick ${t}: DIVERGED at byte ${d} (${where}) ref=${ref[t][d]} chk=${chk[t][d]}`,
      );
    }
  }
  if (phaseEqual) ok(`equivalence: ${phase} phase — identical at ticks 50/150/300 (OFF == ON)`);
  else console.log(`FAIL: equivalence: ${phase} phase — DIVERGED (see above)`);
}
if (!allEqual) fail('chunked run diverged from full-scan reference under weather');
ok('EQUIVALENCE: rain + snow phases byte-identical at 50/150/300 (chunked == full scan)');

// ===========================================================================
// 2. RAIN fills water + douses fire faster than clear.
// ===========================================================================
{
  // Ticks for ALL fire to disappear from a lit wood block, under a given phase.
  function ticksToExtinguish(phase: 'rain' | 'clear', maxTicks: number): {
    ticks: number;
    sawWater: boolean;
  } {
    const s = freshSim();
    s.sim.setChunkingEnabled(true);
    seedFireSlab(s);
    s.weather.__setWeatherForTest(phase);
    let sawWater = false;
    for (let t = 1; t <= maxTicks; t++) {
      s.sim.step();
      if (!sawWater && countMat(s, s.mats.WATER) > 0) sawWater = true;
      if (countFire(s) === 0) return { ticks: t, sawWater };
    }
    return { ticks: maxTicks + 1, sawWater }; // sentinel: never extinguished
  }

  const MAX = 2000;
  const clear = ticksToExtinguish('clear', MAX);
  const rain = ticksToExtinguish('rain', MAX);

  if (clear.sawWater) fail('clear phase should NOT spawn WATER from the sky');
  if (!rain.sawWater) fail('rain phase did NOT spawn any WATER from the sky');
  ok(`rain spawns sky WATER (rain sawWater=${rain.sawWater}, clear sawWater=${clear.sawWater})`);

  if (rain.ticks > MAX) fail('fire never went out under rain within the budget');
  if (clear.ticks > MAX) {
    // Clear never finished within budget while rain did → rain is strictly faster.
    ok(`rain douses faster: rain=${rain.ticks} ticks, clear still burning at ${MAX}`);
  } else {
    if (!(rain.ticks < clear.ticks)) {
      fail(`rain (${rain.ticks}) must extinguish STRICTLY faster than clear (${clear.ticks})`);
    }
    ok(`rain douses fire faster: rain=${rain.ticks} ticks < clear=${clear.ticks} ticks`);
  }
}

// ===========================================================================
// 3. SNOW accumulates over time + forms a stable pile + no-tunnel.
// ===========================================================================
{
  const s = freshSim();
  s.sim.setChunkingEnabled(true);
  floor(s);
  s.weather.__setWeatherForTest('snow');

  const samples: { t: number; snow: number }[] = [];
  const SAMPLE_AT = [50, 150, 300, 500];
  const LAST = SAMPLE_AT[SAMPLE_AT.length - 1];
  for (let t = 1; t <= LAST; t++) {
    s.sim.step();
    if (SAMPLE_AT.indexOf(t) !== -1) samples.push({ t, snow: countMat(s, s.mats.SNOW) });
  }

  // (a) SNOW mass GROWS over time (accumulation).
  let growing = true;
  for (let i = 1; i < samples.length; i++) {
    if (!(samples[i].snow > samples[i - 1].snow)) growing = false;
  }
  if (!growing) {
    fail(`snow did not accumulate monotonically: ${samples.map((x) => `${x.t}:${x.snow}`).join(' ')}`);
  }
  ok(`snow accumulates: ${samples.map((x) => `t${x.t}=${x.snow}`).join(' ')}`);

  // (b) STABLE PILE — snow rests ON the floor (a settled drift sitting on the
  //     stone floor row, i.e. cells at FLOOR_Y-1). Proves it piles, not just
  //     free-falls and vanishes.
  let pileOnFloor = 0;
  for (let x = FLOOR_X0; x <= FLOOR_X1; x++) {
    if (s.grid.material[(FLOOR_Y - 1) * W + x] === s.mats.SNOW) pileOnFloor++;
  }
  if (pileOnFloor === 0) fail('no settled SNOW found resting on the floor (no stable pile)');
  ok(`snow forms a stable pile on the floor (${pileOnFloor} snow cells at FLOOR_Y-1)`);

  // (c) NO-TUNNEL — nothing fell through the solid stone floor.
  let below = 0;
  for (let y = FLOOR_Y + 1; y < H; y++) {
    for (let x = FLOOR_X0; x <= FLOOR_X1; x++) {
      const m = s.grid.material[y * W + x];
      if (m === s.mats.SNOW || m === s.mats.WATER) below++;
    }
  }
  if (below > 0) fail(`no-tunnel(snow): ${below} cells tunnelled below the stone floor`);
  ok('no-tunnel(snow): 0 snow/water cells below the floor');
}

console.log('\nALL PASS');
console.log(
  `SUMMARY: chunk-equiv=${allEqual ? 'EQUAL' : 'NOTEQUAL'} (rain+snow × 3 checkpoints), ` +
  `rain-douse=faster+spawns-water, snow=accumulates+stable-pile+no-tunnel`,
);
if (typeof process !== 'undefined' && !allEqual) process.exit(1);
