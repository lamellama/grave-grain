/**
 * test/p11-chunk-equiv.test.ts — Phase 11 task 11-2 equivalence + perf gate.
 *
 * THE bar: the chunked / dirty-rect cellular update (chunking ON) must produce
 * output BYTE-IDENTICAL to the full grid scan (chunking OFF). We run the SAME
 * seeded scene under both modes and diff material+integrity at ticks 50/150/300.
 *
 * Battery (brief Done-when #1): (a) suspended SAND blob falling+piling on stone,
 * (b) WATER column seeking level, (c) FIRE spreading through a WOOD block →
 * ash+smoke, (d) a released gore pile (FLESH/BONE/BLOOD) falling+settling.
 * Plus #2 no-tunnel and #3 perf-proof (settled ≈0 chunks; locality; an edit /
 * ignite into a settled chunk re-activates it next tick).
 *
 * Real engine modules. Each run uses a FRESH module graph (busts the CommonJS
 * require-cache) so tick, the grid arrays, and the chunk-activity bitsets all
 * reset to tick-0 / all-chunks-active.
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
  const sim = require('../src/engine/simulation');
  return { config, grid, mats, chunks, sim };
}
type Sim = ReturnType<typeof freshSim>;

// ---------------------------------------------------------------------------
// Scene seeders (fixed constants → both runs seed byte-identically).
// All scenarios share a STONE floor so falling matter has something to rest on
// (and a no-tunnel reference row).
// ---------------------------------------------------------------------------
const FLOOR_Y = 150;
const FLOOR_X0 = 100;
const FLOOR_X1 = 200;

function floor(s: Sim): void {
  const { grid, mats } = s;
  grid.material.fill(0);
  grid.integrity.fill(0);
  for (let x = FLOOR_X0; x <= FLOOR_X1; x++) grid.set(x, FLOOR_Y, mats.STONE);
}

// (a) suspended SAND blob → falls and piles at repose on the floor.
function seedSand(s: Sim): void {
  floor(s);
  const { grid, mats } = s;
  for (let y = 100; y < 112; y++)
    for (let x = 130; x < 160; x++) grid.set(x, y, mats.SAND);
}

// (b) tall narrow WATER column → collapses to a flat sheet (seeks level).
function seedWater(s: Sim): void {
  floor(s);
  const { grid, mats } = s;
  for (let y = 110; y < FLOOR_Y; y++)
    for (let x = 146; x < 154; x++) grid.set(x, y, mats.WATER);
}

// (c) WOOD block with its top row ignited → fire spreads, leaves ash + smoke.
function seedFire(s: Sim): void {
  floor(s);
  const { grid, mats, sim } = s;
  for (let y = 142; y < FLOOR_Y; y++)
    for (let x = 140; x < 161; x++) grid.placeMaterial(x, y, mats.WOOD);
  for (let x = 140; x < 161; x++) sim.ignite(x, 141);
}

// (d) released GORE pile (FLESH / BONE / BLOOD) suspended → falls and settles,
//     bone sinking beneath flesh, blood seeking its level.
function seedGore(s: Sim): void {
  floor(s);
  const { grid, mats } = s;
  for (let y = 100; y < 108; y++)
    for (let x = 132; x < 158; x++) grid.set(x, y, mats.FLESH);
  for (let y = 108; y < 112; y++)
    for (let x = 136; x < 154; x++) grid.set(x, y, mats.BONE);
  for (let y = 96; y < 100; y++)
    for (let x = 138; x < 152; x++) grid.set(x, y, mats.BLOOD);
}

// (e) CAMPFIRE (VS-2 T-C): a managed contained fire next to WOOD. It must burn
//     (probabilistic fuel countdown via simRand) WITHOUT spreading - and stay
//     byte-identical chunked vs full (deterministic per x,y,tick + markCellActive
//     keeps its chunk live every tick, same invariant as FIRE).
function seedCampfire(s: Sim): void {
  floor(s);
  const { grid, mats } = s;
  for (let x = 140; x < 161; x++) grid.placeMaterial(x, FLOOR_Y - 1, mats.CAMPFIRE);
  // Flammable WOOD touching the campfires - proves no-spread holds under both modes.
  for (let y = FLOOR_Y - 4; y < FLOOR_Y - 1; y++)
    for (let x = 162; x < 168; x++) grid.placeMaterial(x, y, mats.WOOD);
}

// (f) STONE gravity (playtest v0.9 N): a LONE stone falls straight down while
//     mortared stone (a pair, a column) holds - all deterministic neighbour
//     reads + trySwap, so chunked vs full must stay byte-identical, including
//     the wake/settle boundary around the faller.
function seedStoneGravity(s: Sim): void {
  floor(s);
  const { grid, mats } = s;
  grid.set(150, 100, mats.STONE); // lone -> falls 49 cells onto the floor
  grid.set(120, 105, mats.STONE); // pair -> holds (mutual mortar)
  grid.set(121, 105, mats.STONE);
  for (let y = 120; y < 126; y++) grid.set(135, y, mats.STONE); // column -> holds
}

// (g) SOAK (playtest v0.11 S): a standing water sheet on a DIRT-bottomed,
//     stone-walled basin drains bottom-up via applySoak (per-column simRand
//     rolls, non-chunk-gated sweep) while the sheet re-levels - must stay
//     byte-identical chunked vs full, including the wake around each absorbed
//     cell. Dirt is fully enclosed (stone shelf below, walls at the ends) so
//     the known updateDirt edge-diagonal gap (see PROGRESS) never triggers.
function seedSoak(s: Sim): void {
  floor(s);
  const { grid, mats } = s;
  for (let y = FLOOR_Y - 7; y < FLOOR_Y; y++) {
    grid.set(110, y, mats.STONE); // basin walls
    grid.set(190, y, mats.STONE);
  }
  for (let x = 111; x < 190; x++)
    for (let y = FLOOR_Y - 2; y < FLOOR_Y; y++) grid.set(x, y, mats.DIRT);
  for (let x = 111; x < 190; x++)
    for (let y = FLOOR_Y - 4; y < FLOOR_Y - 2; y++) grid.set(x, y, mats.WATER);
}

function snapshot(s: Sim): Uint8Array {
  const n = s.grid.material.length;
  const snap = new Uint8Array(n * 2);
  snap.set(s.grid.material, 0);
  snap.set(s.grid.integrity, n);
  return snap;
}

const CHECKPOINTS = [50, 150, 300];

/** Run a scenario in one mode, capturing snapshots at the checkpoints. */
function runScenario(
  seed: (s: Sim) => void,
  chunking: boolean,
): Record<number, Uint8Array> {
  const s = freshSim();
  s.sim.setChunkingEnabled(chunking);
  seed(s);
  const out: Record<number, Uint8Array> = {};
  const last = CHECKPOINTS[CHECKPOINTS.length - 1];
  for (let t = 1; t <= last; t++) {
    s.sim.step();
    if (CHECKPOINTS.indexOf(t) !== -1) out[t] = snapshot(s);
  }
  return out;
}

/** First divergent cell index between two snapshots, or -1 if identical. */
function firstDiff(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length) return 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return i;
  return -1;
}

// ===========================================================================
// 1. EQUIVALENCE BATTERY — chunking OFF (reference) vs ON, byte-for-byte.
// ===========================================================================
const SCENARIOS: Array<{ name: string; seed: (s: Sim) => void }> = [
  { name: 'SAND blob fall+pile', seed: seedSand },
  { name: 'WATER column seeks level', seed: seedWater },
  { name: 'FIRE through WOOD → ash+smoke', seed: seedFire },
  { name: 'GORE pile (flesh/bone/blood) settle', seed: seedGore },
  { name: 'CAMPFIRE burns next to WOOD (no spread)', seed: seedCampfire },
  { name: 'STONE gravity: lone falls, mortared holds', seed: seedStoneGravity },
  { name: 'SOAK: sheet on dirt drains bottom-up', seed: seedSoak },
];

const W = freshSim().config.WORLD_W;
let allEqual = true;
for (const { name, seed } of SCENARIOS) {
  const ref = runScenario(seed, false); // full-scan reference
  const chk = runScenario(seed, true); // chunked
  let scenarioEqual = true;
  for (const t of CHECKPOINTS) {
    const d = firstDiff(ref[t], chk[t]);
    if (d !== -1) {
      scenarioEqual = false;
      allEqual = false;
      const n = ref[t].length / 2;
      const where = d < n ? `material[${d % W},${(d / W) | 0}]` : `integrity@${d - n}`;
      console.log(
        `  [${name}] tick ${t}: DIVERGED at byte ${d} (${where}) ref=${ref[t][d]} chk=${chk[t][d]}`,
      );
    }
  }
  if (scenarioEqual) ok(`equivalence: ${name} — identical at ticks 50/150/300`);
  else console.log(`FAIL: equivalence: ${name} — DIVERGED (see above)`);
}
if (!allEqual) fail('chunked run diverged from full-scan reference');
ok('EQUIVALENCE BATTERY: all 7 scenarios byte-identical at 50/150/300 (OFF == ON)');

// ===========================================================================
// 2. NO-TUNNEL — nothing falls through the stone floor (checked on chunked run).
// ===========================================================================
function noTunnel(seed: (s: Sim) => void, mats: number[], label: string): void {
  const s = freshSim();
  s.sim.setChunkingEnabled(true);
  seed(s);
  for (let t = 0; t < 300; t++) s.sim.step();
  let below = 0;
  for (let y = FLOOR_Y + 1; y < s.config.WORLD_H; y++) {
    for (let x = FLOOR_X0; x <= FLOOR_X1; x++) {
      if (mats.indexOf(s.grid.material[y * s.config.WORLD_W + x]) !== -1) below++;
    }
  }
  if (below > 0) fail(`no-tunnel(${label}): ${below} cells tunnelled below the floor`);
  ok(`no-tunnel(${label}): 0 cells below the floor`);
}
{
  const m = freshSim().mats;
  noTunnel(seedSand, [m.SAND], 'sand');
  noTunnel(seedGore, [m.FLESH, m.BONE], 'gore');
}

// ===========================================================================
// 3. PERF PROOF — settled ≈0 chunks; locality; edit re-activates next tick.
// ===========================================================================

// (3a) A fully settled world (stone floor + empty sky) processes ≈0 chunks/tick.
{
  const s = freshSim();
  s.sim.setChunkingEnabled(true);
  floor(s); // nothing can move
  for (let t = 0; t < 5; t++) s.sim.step(); // let the first full pass settle
  const active = s.sim.activeThisTickCount();
  const total = s.sim.chunkCount();
  if (active !== 0) fail(`settled world still processes ${active}/${total} chunks (expected 0)`);
  ok(`perf: fully settled world processes ${active}/${total} chunks/tick (≈0)`);
}

// (3b) An isolated falling blob wakes only its LOCAL + neighbour chunks — far
//      fewer than the whole world.
{
  const s = freshSim();
  s.sim.setChunkingEnabled(true);
  floor(s);
  for (let y = 110; y < 122; y++)
    for (let x = 145; x < 160; x++) s.grid.set(x, y, s.mats.SAND);
  for (let t = 0; t < 4; t++) s.sim.step(); // blob actively falling
  const active = s.sim.activeThisTickCount();
  const total = s.sim.chunkCount();
  if (active >= total) fail('isolated blob woke the whole world');
  if (active > 24) fail(`isolated blob woke ${active} chunks — not local (expected a handful)`);
  ok(`perf: isolated falling blob wakes only ${active}/${total} chunks (local)`);
}

// (3c) A player edit / ignite into a SETTLED chunk re-activates it the NEXT
//      tick (the chunk that was inactive is processed and its cell updates).
{
  const s = freshSim();
  s.sim.setChunkingEnabled(true);
  floor(s);
  for (let t = 0; t < 5; t++) s.sim.step();
  if (s.sim.activeThisTickCount() !== 0) fail('world did not settle before edit test');

  // Place a sand grain high in a previously-settled region with air below it.
  const EX = 600;
  const EY = 40;
  s.grid.set(EX, EY, s.mats.SAND);
  const ccBefore = s.sim.activeThisTickCount(); // still this tick's set (pre-step)
  s.sim.step(); // the woken chunk is processed → grain falls one row
  const activeAfter = s.sim.activeThisTickCount();
  const grainFell =
    s.grid.material[EY * s.config.WORLD_W + EX] === s.mats.AIR &&
    s.grid.material[(EY + 1) * s.config.WORLD_W + EX] === s.mats.SAND;
  if (activeAfter < 1) fail('edit into settled world did not re-activate any chunk');
  if (!grainFell) fail('re-activated chunk was not processed (grain did not fall)');
  ok(`perf: edit into settled chunk re-activates next tick (active ${ccBefore}→${activeAfter}, grain fell)`);

  // Ignite into a settled chunk: place wood, settle, ignite → fire must appear
  // and age (a non-zero active set proves the chunk is live).
  const f = freshSim();
  f.sim.setChunkingEnabled(true);
  f.grid.material.fill(0);
  f.grid.integrity.fill(0);
  for (let x = 700; x < 710; x++) f.grid.placeMaterial(x, 130, f.mats.WOOD);
  for (let t = 0; t < 5; t++) f.sim.step();
  f.sim.ignite(705, 129);
  f.sim.step();
  const fireLive = f.grid.material[129 * f.config.WORLD_W + 705] === f.mats.FIRE;
  if (!fireLive) fail('ignite into settled chunk did not produce a live FIRE next tick');
  if (f.sim.activeThisTickCount() < 1) fail('ignite did not keep the chunk active');
  ok('perf: ignite into settled chunk re-activates next tick (live fire processed)');
}

console.log('\nALL PASS');
console.log(
  `SUMMARY: equivalence=${allEqual ? 'EQUAL' : 'NOTEQUAL'} (6 scenarios × 3 checkpoints), ` +
  `no-tunnel=OK, perf settled=0 chunks, locality+reactivation OK`,
);
if (typeof process !== 'undefined' && !allEqual) process.exit(1);
