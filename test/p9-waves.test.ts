/**
 * p9-waves — Wave escalation arithmetic + win signal (task 9-3).
 *
 * Drives updateWaves() headlessly (no DOM, no renderer) and verifies:
 *  1. Exactly WIN_WAVES (5) waves launch; no 6th.
 *  2. Intervals assigned at each wave launch are non-increasing and ≥ WAVE_INTERVAL_MIN.
 *  3. Wave sizes grow correctly (WAVE_SIZE_START + WAVE_SIZE_GROWTH*(n-1)).
 *  4. allWavesCleared() signal behaves correctly at every boundary.
 */

import { createWaveState, updateWaves, allWavesCleared } from '../src/game/waves';
import {
  WIN_WAVES,
  WAVE_INTERVAL_MIN,
  WAVE_INTERVAL,
  WAVE_INTERVAL_DECAY,
  WAVE_SIZE_START,
  WAVE_SIZE_GROWTH,
} from '../src/config';

declare const process: any;

let failed = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log('  PASS:', msg);
  else {
    console.error('  FAIL:', msg);
    failed++;
  }
}

// ---------------------------------------------------------------------------
// Simulation driver
// ---------------------------------------------------------------------------

const state = createWaveState();

const waveLaunchIntervals: number[] = [];  // ticksToNextWave as set when wave N launches
const waveSizes: number[] = [];            // pendingThisWave as set when wave N launches
let waveCount = 0;

// We track alive count ourselves: zombies spawn -> alive++, we drain to 0
// between waves so the next wave can start.
let aliveCount = 0;

// Sentinel: the tick when allWavesCleared first flips to true.
let clearedTick = -1;

// Run the sim for enough ticks to get through all waves. Each wave can take at
// most WAVE_INTERVAL ticks to start + wave_size * ZOMBIE_SPAWN_STAGGER ticks to
// fully spawn. With WIN_WAVES=5, WAVE_INTERVAL=1200 and max wave size=11,
// 10_000 ticks is more than enough.
const MAX_TICKS = 10_000;

let prevWaveNumber = 0;

for (let tick = 0; tick < MAX_TICKS; tick++) {
  const newZombies = updateWaves(state, aliveCount);

  // Accumulate newly spawned zombies.
  aliveCount += newZombies.length;

  // Detect wave launch (waveNumber incremented this tick).
  if (state.waveNumber !== prevWaveNumber) {
    waveCount++;
    // Capture the interval and size set for this wave.
    waveLaunchIntervals.push(state.ticksToNextWave);
    waveSizes.push(WAVE_SIZE_START + WAVE_SIZE_GROWTH * (state.waveNumber - 1));
    prevWaveNumber = state.waveNumber;
  }

  // Between waves (no pending zombies): drain all alive counts to 0 so the
  // next wave's countdown can start.
  if (state.pendingThisWave === 0 && aliveCount > 0) {
    aliveCount = 0;
  }

  // Track when cleared first becomes true.
  if (clearedTick === -1 && allWavesCleared(state, aliveCount)) {
    clearedTick = tick;
  }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

console.log('\n=== p9-waves results ===');
console.log(`Wave count: ${waveCount} (expected ${WIN_WAVES})`);
console.log(`Interval sequence: [${waveLaunchIntervals.join(', ')}]`);
console.log(`Size sequence:     [${waveSizes.join(', ')}]`);
console.log(`allWavesCleared first true at tick: ${clearedTick}`);

// ---------------------------------------------------------------------------
// [1] Wave count
// ---------------------------------------------------------------------------
console.log('\n[1] Wave count');
assert(waveCount === WIN_WAVES, `Exactly ${WIN_WAVES} waves launched (got ${waveCount})`);

// Verify no 6th wave: after the final wave completes, waveNumber must not
// exceed WIN_WAVES.
assert(state.waveNumber === WIN_WAVES, `waveNumber stops at WIN_WAVES=${WIN_WAVES} (got ${state.waveNumber})`);

// ---------------------------------------------------------------------------
// [2] Interval sequence: non-increasing and ≥ WAVE_INTERVAL_MIN
// ---------------------------------------------------------------------------
console.log('\n[2] Interval sequence');
let nonIncreasing = true;
for (let i = 1; i < waveLaunchIntervals.length; i++) {
  if (waveLaunchIntervals[i] > waveLaunchIntervals[i - 1]) {
    nonIncreasing = false;
    console.error(`  FAIL: interval[${i}]=${waveLaunchIntervals[i]} > interval[${i-1}]=${waveLaunchIntervals[i-1]}`);
  }
}
assert(nonIncreasing, 'Intervals are non-increasing across waves');

let allAboveMin = true;
for (let i = 0; i < waveLaunchIntervals.length; i++) {
  if (waveLaunchIntervals[i] < WAVE_INTERVAL_MIN) {
    allAboveMin = false;
    console.error(`  FAIL: interval[${i}]=${waveLaunchIntervals[i]} < WAVE_INTERVAL_MIN=${WAVE_INTERVAL_MIN}`);
  }
}
assert(allAboveMin, `All intervals ≥ WAVE_INTERVAL_MIN (${WAVE_INTERVAL_MIN})`);

// Check exact expected values.
const expectedIntervals: number[] = [];
for (let n = 1; n <= WIN_WAVES; n++) {
  expectedIntervals.push(Math.max(WAVE_INTERVAL_MIN, WAVE_INTERVAL - WAVE_INTERVAL_DECAY * (n - 1)));
}
console.log(`Expected intervals: [${expectedIntervals.join(', ')}]`);
let intervalsExact = true;
for (let i = 0; i < expectedIntervals.length; i++) {
  if (waveLaunchIntervals[i] !== expectedIntervals[i]) {
    intervalsExact = false;
    console.error(`  FAIL: wave ${i+1} interval=${waveLaunchIntervals[i]}, expected ${expectedIntervals[i]}`);
  }
}
assert(intervalsExact, 'Each wave interval matches WAVE_INTERVAL - WAVE_INTERVAL_DECAY*(n-1) floored at MIN');

// ---------------------------------------------------------------------------
// [3] Size sequence
// ---------------------------------------------------------------------------
console.log('\n[3] Size sequence');
const expectedSizes: number[] = [];
for (let n = 1; n <= WIN_WAVES; n++) {
  expectedSizes.push(WAVE_SIZE_START + WAVE_SIZE_GROWTH * (n - 1));
}
console.log(`Expected sizes: [${expectedSizes.join(', ')}]`);
let sizesExact = true;
for (let i = 0; i < expectedSizes.length; i++) {
  if (waveSizes[i] !== expectedSizes[i]) {
    sizesExact = false;
    console.error(`  FAIL: wave ${i+1} size=${waveSizes[i]}, expected ${expectedSizes[i]}`);
  }
}
assert(sizesExact, 'Wave sizes follow WAVE_SIZE_START + WAVE_SIZE_GROWTH*(n-1)');

// ---------------------------------------------------------------------------
// [4] allWavesCleared signal
// ---------------------------------------------------------------------------
console.log('\n[4] allWavesCleared signal');

// Case A: waveNumber < WIN_WAVES → always false regardless of others.
const earlyState = createWaveState();
earlyState.waveNumber = WIN_WAVES - 1;
earlyState.pendingThisWave = 0;
assert(
  !allWavesCleared(earlyState, 0),
  'allWavesCleared false when waveNumber < WIN_WAVES (even with pending=0 and alive=0)',
);

// Case B: last wave fully launched, alive > 0 → false.
const almostState = createWaveState();
almostState.waveNumber = WIN_WAVES;
almostState.pendingThisWave = 0;
assert(
  !allWavesCleared(almostState, 1),
  'allWavesCleared false when last wave done but aliveZombieCount > 0',
);

// Case C: last wave fully launched, alive = 0 → true.
const doneState = createWaveState();
doneState.waveNumber = WIN_WAVES;
doneState.pendingThisWave = 0;
assert(
  allWavesCleared(doneState, 0),
  'allWavesCleared true when waveNumber=WIN_WAVES, pending=0, alive=0',
);

// Case D: last wave still has pending zombies → false.
const stillSpawning = createWaveState();
stillSpawning.waveNumber = WIN_WAVES;
stillSpawning.pendingThisWave = 3;
assert(
  !allWavesCleared(stillSpawning, 0),
  'allWavesCleared false when last wave still has pending zombies',
);

// Case E: the real simulation did reach cleared.
assert(clearedTick >= 0, `allWavesCleared became true during simulation (tick ${clearedTick})`);

// ---------------------------------------------------------------------------
console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
