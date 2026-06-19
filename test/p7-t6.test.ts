/**
 * p7-t6.test.ts — headless unit test for game/waves.ts (GDD §7.1).
 *
 * Verifies:
 *   1. Wave 1 spawns exactly WAVE_SIZE_START zombies, all at the correct edge x.
 *   2. Wave 2 (after WAVE_INTERVAL) spawns WAVE_SIZE_START + WAVE_SIZE_GROWTH.
 *   3. Spawns are staggered — at most 1 per tick, ZOMBIE_SPAWN_STAGGER apart.
 *   4. Concurrent cap: while aliveCount === MAX_ZOMBIES nothing is spawned.
 */

import { createWaveState, updateWaves } from '../src/game/waves';
import {
  WAVE_SIZE_START,
  WAVE_SIZE_GROWTH,
  WAVE_INTERVAL,
  ZOMBIE_SPAWN_STAGGER,
  MAX_ZOMBIES,
  ZOMBIE_SPAWN_EDGE,
  WORLD_W,
} from '../src/config';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const EXPECTED_X = ZOMBIE_SPAWN_EDGE === 'left' ? 1 : WORLD_W - 2;

function runTicks(
  maxTicks: number,
  aliveSupplier: (collected: number) => number,
  stopAfterWave?: number,
): { spawnTicks: number[]; spawnXs: number[]; waveEndsAtTick: number[] } {
  const state = createWaveState();
  const spawnTicks: number[] = [];
  const spawnXs: number[] = [];
  const waveEndsAtTick: number[] = [];
  let collected = 0;
  let prevWave = 0;

  for (let t = 0; t < maxTicks; t++) {
    const alive = aliveSupplier(collected);
    const batch = updateWaves(state, alive);
    if (batch.length > 0) {
      for (const z of batch) {
        spawnTicks.push(t);
        spawnXs.push(z.body.x);
        collected++;
      }
    }
    if (state.waveNumber > prevWave) {
      // Wave just started; nothing to log until pending drains.
      prevWave = state.waveNumber;
    }
    if (stopAfterWave !== undefined && collected >= expectedWaveTotal(stopAfterWave)) {
      // Give one extra interval so wave 2 can also run if asked.
      break;
    }
  }
  return { spawnTicks, spawnXs, waveEndsAtTick };
}

function expectedWaveTotal(wave: number): number {
  let total = 0;
  for (let w = 1; w <= wave; w++) {
    total += WAVE_SIZE_START + WAVE_SIZE_GROWTH * (w - 1);
  }
  return total;
}

// ---------------------------------------------------------------------------
// T1 — Wave 1: correct count and edge x.
// ---------------------------------------------------------------------------
{
  const state = createWaveState();
  const spawnTicks: number[] = [];
  const spawnXs: number[] = [];
  let collected = 0;
  const wave1Size = WAVE_SIZE_START; // 3

  // Run enough ticks to cover the initial interval + wave 1 spawning.
  // WAVE_INTERVAL + wave1Size * ZOMBIE_SPAWN_STAGGER + safety.
  const limit = WAVE_INTERVAL + wave1Size * ZOMBIE_SPAWN_STAGGER + 200;
  let wave1Done = false;
  for (let t = 0; t < limit; t++) {
    const batch = updateWaves(state, collected); // alive grows as we collect
    for (const z of batch) {
      spawnTicks.push(t);
      spawnXs.push(z.body.x);
      collected++;
    }
    if (collected >= wave1Size && !wave1Done) {
      wave1Done = true;
      break;
    }
  }

  const correctCount = collected === wave1Size;
  const correctX = spawnXs.every(x => x === EXPECTED_X);

  // Stagger: consecutive spawn ticks must differ by >= ZOMBIE_SPAWN_STAGGER
  // (the first can be on any tick; subsequent ones must be >= STAGGER apart).
  let staggerOk = true;
  for (let i = 1; i < spawnTicks.length; i++) {
    if (spawnTicks[i] - spawnTicks[i - 1] < ZOMBIE_SPAWN_STAGGER) {
      staggerOk = false;
    }
  }

  // At most 1 per tick.
  const atMostOnePerTick = spawnTicks.length === new Set(spawnTicks).size;

  console.log('T1 wave1 spawned:', collected, '(expected', wave1Size + ')');
  console.log('T1 spawnTicks:', spawnTicks);
  console.log('T1 spawnXs:', spawnXs, '(expected x =', EXPECTED_X + ')');
  console.log('T1 staggerOk:', staggerOk, 'atMostOnePerTick:', atMostOnePerTick);
  const t1pass = correctCount && correctX && staggerOk && atMostOnePerTick;
  console.log('T1 PASS wave1 count+edge+stagger:', t1pass);

  // ---------------------------------------------------------------------------
  // T2 — Wave 2: spawns WAVE_SIZE_START + WAVE_SIZE_GROWTH zombies.
  // ---------------------------------------------------------------------------
  const wave2Size = WAVE_SIZE_START + WAVE_SIZE_GROWTH; // 5
  const wave2Ticks: number[] = [];
  // Continue from the same state (wave 1 already dispatched).
  let wave2Collected = 0;
  const wave2Limit = WAVE_INTERVAL + wave2Size * ZOMBIE_SPAWN_STAGGER + 200;
  let totalCollected = collected; // running total (used as alive count)
  for (let t = 0; t < wave2Limit; t++) {
    const batch = updateWaves(state, totalCollected);
    for (const z of batch) {
      wave2Ticks.push(t);
      wave2Collected++;
      totalCollected++;
    }
    if (wave2Collected >= wave2Size) break;
  }

  const t2pass = wave2Collected === wave2Size;
  console.log('\nT2 wave2 spawned:', wave2Collected, '(expected', wave2Size + ')');
  console.log('T2 PASS wave2 size:', t2pass);

  // ---------------------------------------------------------------------------
  // T3 — Concurrent cap: feed MAX_ZOMBIES as alive count → nothing spawns.
  // ---------------------------------------------------------------------------
  const capState = createWaveState();
  let capSpawned = 0;

  // Fast-forward to just before the wave fires.
  for (let t = 0; t < WAVE_INTERVAL - 1; t++) {
    updateWaves(capState, MAX_ZOMBIES);
  }
  // Wave should start on next tick; now keep alive at MAX_ZOMBIES.
  const CAP_TEST_TICKS = WAVE_SIZE_START * ZOMBIE_SPAWN_STAGGER * 4;
  for (let t = 0; t < CAP_TEST_TICKS; t++) {
    const batch = updateWaves(capState, MAX_ZOMBIES);
    capSpawned += batch.length;
  }
  const t3pass = capSpawned === 0;
  console.log('\nT3 cap test: spawned while at MAX_ZOMBIES =', capSpawned, '(expected 0)');
  console.log('T3 PASS cap blocks spawns:', t3pass);

  // Verify that releasing one slot causes an immediate spawn.
  const releaseState = createWaveState();
  // Get into a wave with a pending zombie.
  for (let t = 0; t < WAVE_INTERVAL - 1; t++) updateWaves(releaseState, MAX_ZOMBIES);
  // Tick the wave start with cap still full.
  updateWaves(releaseState, MAX_ZOMBIES);
  // Keep at cap for a few ticks (pending should accumulate).
  for (let t = 0; t < 5; t++) updateWaves(releaseState, MAX_ZOMBIES);
  // Now drop one — should spawn immediately.
  const released = updateWaves(releaseState, MAX_ZOMBIES - 1);
  const t3bpass = released.length === 1;
  console.log('T3b releasing cap → immediate spawn:', released.length, '(expected 1)');
  console.log('T3b PASS:', t3bpass);

  // ---------------------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------------------
  console.log('\nSUMMARY T1', t1pass, 'T2', t2pass, 'T3', t3pass, 'T3b', t3bpass,
    'ALL', t1pass && t2pass && t3pass && t3bpass);
}
