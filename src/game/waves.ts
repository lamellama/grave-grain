/**
 * game/waves.ts — Escalating zombie wave spawner (GDD §7.1).
 *
 * Pure logic: no DOM, no renderer, no live-list references. Returns newly-spawned
 * Zombie objects; the caller (main) appends them to its live list and registers
 * them for the renderer.
 *
 * DESIGN
 * ------
 * Waves are numbered from 1. Wave N sends
 *   WAVE_SIZE_START + WAVE_SIZE_GROWTH × (N − 1)
 * zombies total, staggered one-at-a-time with ZOMBIE_SPAWN_STAGGER ticks between
 * each spawn so the horde trickles onto the map rather than appearing as a block.
 * While the live count is at MAX_ZOMBIES the spawner defers (doesn't consume
 * `pendingThisWave`); it retries on every subsequent tick until room opens.
 *
 * INITIAL DELAY
 * -------------
 * `createWaveState` seeds `ticksToNextWave = WAVE_INTERVAL` — the player gets
 * a full WAVE_INTERVAL ticks (20 s at SIM_HZ 60) before the first wave lands,
 * giving them time to orient and set up defences. Change to a shorter constant
 * here if an earlier first wave is wanted during play-testing.
 */

import { createZombie } from '../characters/zombie';
import type { Zombie } from '../characters/zombie';
import {
  WAVE_INTERVAL,
  WAVE_INTERVAL_MIN,
  WAVE_INTERVAL_DECAY,
  WAVE_SIZE_START,
  WAVE_SIZE_GROWTH,
  ZOMBIE_SPAWN_STAGGER,
  MAX_ZOMBIES,
  WIN_WAVES,
  ZOMBIE_SPAWN_EDGE,
  ZOMBIE_SPAWN_Y,
  WORLD_W,
} from '../config';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * All mutable state needed to drive the wave machine.
 * Kept in a plain object so it is easy to serialise / inspect in tests.
 */
export interface WaveState {
  /** How many full waves have been launched (0 = none yet). */
  waveNumber: number;
  /** Ticks until the next wave starts (counting down). */
  ticksToNextWave: number;
  /** Zombies still to be spawned in the current wave (0 = between waves). */
  pendingThisWave: number;
  /** Ticks until the next single zombie may be spawned within a wave. */
  ticksToNextSpawn: number;
}

/**
 * Create the initial wave state.
 * The first wave arrives after WAVE_INTERVAL ticks so the player has time to
 * set up before first contact (documented in the file header above).
 */
export function createWaveState(): WaveState {
  return {
    waveNumber: 0,
    ticksToNextWave: WAVE_INTERVAL,
    pendingThisWave: 0,
    ticksToNextSpawn: 0,
  };
}

/**
 * Advance the wave machine by one simulation tick.
 *
 * Returns an array of Zombie objects spawned THIS tick (almost always [] or a
 * single-element array; theoretically never more than one per tick due to
 * staggering).
 *
 * @param state            WaveState — mutated in place.
 * @param aliveZombieCount Total living zombies on the map RIGHT NOW. The caller
 *                         computes this (e.g. `zombies.filter(z => z.body.alive).length`)
 *                         so this module never holds a reference to the live list.
 */
export function updateWaves(state: WaveState, aliveZombieCount: number): Zombie[] {
  const spawned: Zombie[] = [];

  if (state.pendingThisWave === 0) {
    // ---- Between waves: count down to the next wave trigger. ----
    // Once WIN_WAVES have been launched, stop scheduling further waves.
    if (state.waveNumber >= WIN_WAVES) return spawned;

    state.ticksToNextWave--;
    if (state.ticksToNextWave <= 0) {
      // Launch a new wave.
      state.waveNumber++;
      state.pendingThisWave =
        WAVE_SIZE_START + WAVE_SIZE_GROWTH * (state.waveNumber - 1);
      // Frequency escalation: interval shrinks each wave, floored at MIN.
      state.ticksToNextWave = Math.max(
        WAVE_INTERVAL_MIN,
        WAVE_INTERVAL - WAVE_INTERVAL_DECAY * (state.waveNumber - 1),
      );
      // First zombie spawns immediately (ticksToNextSpawn starts at 0 so it
      // fires on the very first tick we enter the pendingThisWave > 0 branch).
      state.ticksToNextSpawn = 0;
    }
  } else {
    // ---- Within a wave: stagger individual spawns. ----
    state.ticksToNextSpawn--;

    if (state.ticksToNextSpawn <= 0) {
      if (aliveZombieCount < MAX_ZOMBIES) {
        // Spawn one zombie at the configured edge.
        const spawnX = ZOMBIE_SPAWN_EDGE === 'left' ? 1 : WORLD_W - 2;
        spawned.push(createZombie(spawnX, ZOMBIE_SPAWN_Y));
        state.pendingThisWave--;
        // Arm the stagger timer for the next zombie in this wave.
        state.ticksToNextSpawn = ZOMBIE_SPAWN_STAGGER;
      }
      // Cap reached: ticksToNextSpawn stays ≤ 0 so we retry on the very next
      // tick. pendingThisWave is NOT decremented — the zombie is deferred, not
      // dropped. Once aliveZombieCount falls below MAX_ZOMBIES the spawner
      // immediately resumes.
    }
  }

  return spawned;
}

/**
 * Returns true once every wave has been launched AND all spawned zombies have
 * been killed. The caller (state.ts / game loop) uses this to trigger the win
 * screen. This function does NOT own the win — it only exposes the signal.
 *
 * Conditions:
 *  - waveNumber has reached WIN_WAVES (all waves launched).
 *  - pendingThisWave === 0 (the last wave's entire roster has been spawned).
 *  - aliveZombieCount === 0 (every zombie on the map is dead).
 */
export function allWavesCleared(
  state: WaveState,
  aliveZombieCount: number,
): boolean {
  return (
    state.waveNumber >= WIN_WAVES &&
    state.pendingThisWave === 0 &&
    aliveZombieCount === 0
  );
}
