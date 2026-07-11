/**
 * game/waves.ts - Escalating zombie wave spawner (GDD 7.1).
 *
 * Pure logic: no DOM, no renderer, no live-list references. Returns newly-spawned
 * Zombie objects; the caller (main) appends them to its live list and registers
 * them for the renderer.
 *
 * DESIGN
 * ------
 * Waves are numbered from 1. Wave N sends
 *   WAVE_SIZE_START + WAVE_SIZE_GROWTH x (N - 1)
 * zombies total. INTERMITTENT DRIP (playtest R9 "instead of waves could they
 * spawn more intermittently"): the roster is spread across roughly
 * ZOMBIE_SPAWN_SPREAD_FRAC of the wave interval with RANDOMISED gaps
 * (0.5x..1.5x the per-wave base gap, floored at ZOMBIE_SPAWN_GAP_MIN), so
 * arrivals read as a continuous trickle rather than a landing block - while
 * the wave counter, escalation and win condition are untouched.
 * While the live count is at MAX_ZOMBIES the spawner defers (doesn't consume
 * `pendingThisWave`); it retries on every subsequent tick until room opens.
 *
 * DUAL-EDGE ESCALATION (GDD 7.1 "one or both edges" / 12.2 zombie-edge count):
 * waves before ZOMBIE_DUAL_EDGE_FROM_WAVE spawn from the single configured
 * ZOMBIE_SPAWN_EDGE; from that wave on, every edge spawn rolls a 50/50 side,
 * so the late game pressures BOTH flanks of the colony.
 *
 * BURROW SPAWNS (playtest R9 "came out of the ground"): when the caller passes
 * `burrowCenterX` (main passes the colony spawn column), each spawn rolls
 * ZOMBIE_BURROW_CHANCE to SURFACE FROM THE SOIL at a column
 * ZOMBIE_BURROW_MIN_DIST..ZOMBIE_BURROW_SPREAD cells from that centre (random
 * side) instead of walking in from the edge - see createBurrowedZombie.
 *
 * INITIAL DELAY
 * -------------
 * `createWaveState` seeds `ticksToNextWave = WAVE_INTERVAL` - the player gets
 * a full WAVE_INTERVAL ticks (20 s at SIM_HZ 60) before the first wave lands,
 * giving them time to orient and set up defences. Change to a shorter constant
 * here if an earlier first wave is wanted during play-testing.
 */

import { createZombie, createBurrowedZombie } from '../characters/zombie';
import type { Zombie } from '../characters/zombie';
import { material, idx } from '../engine/grid';
import { isSolidForBody } from '../engine/materials';
import {
  WAVE_INTERVAL,
  WAVE_INTERVAL_MIN,
  WAVE_INTERVAL_DECAY,
  WAVE_SIZE_START,
  WAVE_SIZE_GROWTH,
  ZOMBIE_SPAWN_GAP_MIN,
  ZOMBIE_SPAWN_SPREAD_FRAC,
  ZOMBIE_BURROW_CHANCE,
  ZOMBIE_BURROW_SPREAD,
  ZOMBIE_BURROW_MIN_DIST,
  MAX_ZOMBIES,
  WIN_WAVES,
  ZOMBIE_SPAWN_EDGE,
  ZOMBIE_DUAL_EDGE_FROM_WAVE,
  WORLD_W,
  WORLD_H,
} from '../config';

// How far in from the map edge zombies spawn, so the whole ~6-wide body is
// in-world (not clipped half off-screen) - playtest fix.
const ZOMBIE_SPAWN_INSET = 4;

// Find the surface row (topmost body-solid cell) of a column so zombies spawn ON
// the rolling worldgen surface instead of a FIXED y that can bury them in a hill
// (a buried head pins the body -> it can't move - playtest: zombies stuck at edge).
function columnSurfaceY(x: number): number {
  for (let y = 0; y < WORLD_H; y++) {
    if (isSolidForBody(material[idx(x, y)])) return y;
  }
  return WORLD_H - 1;
}

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
  /**
   * Base gap (ticks) between this wave's drip spawns, set at launch so the
   * roster spreads over ~ZOMBIE_SPAWN_SPREAD_FRAC of the interval (R9
   * intermittent spawning). Each actual gap is randomised 0.5x..1.5x of this.
   */
  spawnGapBase: number;
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
    spawnGapBase: ZOMBIE_SPAWN_GAP_MIN,
  };
}

/**
 * Advance the wave machine by one simulation tick.
 *
 * Returns an array of Zombie objects spawned THIS tick (almost always [] or a
 * single-element array; theoretically never more than one per tick due to
 * staggering).
 *
 * @param state            WaveState - mutated in place.
 * @param aliveZombieCount Total living zombies on the map RIGHT NOW. The caller
 *                         computes this (e.g. `zombies.filter(z => z.body.alive).length`)
 *                         so this module never holds a reference to the live list.
 */
export function updateWaves(
  state: WaveState,
  aliveZombieCount: number,
  burrowCenterX?: number,
): Zombie[] {
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
      // Intermittent drip (R9): spread this wave's roster across
      // ~ZOMBIE_SPAWN_SPREAD_FRAC of its interval - base gap = spread/size,
      // floored so spawns never machine-gun even for huge late waves.
      state.spawnGapBase = Math.max(
        ZOMBIE_SPAWN_GAP_MIN,
        Math.floor(
          (state.ticksToNextWave * ZOMBIE_SPAWN_SPREAD_FRAC) /
            state.pendingThisWave,
        ),
      );
      // First zombie spawns immediately (ticksToNextSpawn starts at 0 so it
      // fires on the very first tick we enter the pendingThisWave > 0 branch).
      state.ticksToNextSpawn = 0;
    }
  } else {
    // ---- Within a wave: drip individual spawns on randomised gaps. ----
    state.ticksToNextSpawn--;

    if (state.ticksToNextSpawn <= 0) {
      if (aliveZombieCount < MAX_ZOMBIES) {
        // Burrow roll (R9): some spawns claw up out of the ground near the
        // colony instead of walking in from the edge. Math.random is fine
        // here - waves are BODY/AI-layer, never inside the chunked CA.
        if (burrowCenterX !== undefined && Math.random() < ZOMBIE_BURROW_CHANCE) {
          const side = Math.random() < 0.5 ? -1 : 1;
          const dist =
            ZOMBIE_BURROW_MIN_DIST +
            Math.random() * (ZOMBIE_BURROW_SPREAD - ZOMBIE_BURROW_MIN_DIST);
          const bx = Math.min(
            WORLD_W - 1 - ZOMBIE_SPAWN_INSET,
            Math.max(ZOMBIE_SPAWN_INSET, Math.round(burrowCenterX + side * dist)),
          );
          spawned.push(createBurrowedZombie(bx, columnSurfaceY(bx)));
        } else {
          // Edge spawn: inset from the edge, a couple cells ABOVE the actual
          // surface of that column so it lands on top (never buried).
          // DUAL-EDGE ESCALATION (GDD 7.1 "one or both edges" / 12.2): from
          // wave ZOMBIE_DUAL_EDGE_FROM_WAVE each spawn rolls a 50/50 side, so
          // late waves FLANK the colony; earlier waves keep the single
          // configured front.
          const edge =
            state.waveNumber >= ZOMBIE_DUAL_EDGE_FROM_WAVE
              ? Math.random() < 0.5
                ? 'left'
                : 'right'
              : ZOMBIE_SPAWN_EDGE;
          const spawnX =
            edge === 'left'
              ? ZOMBIE_SPAWN_INSET
              : WORLD_W - 1 - ZOMBIE_SPAWN_INSET;
          const spawnY = Math.max(1, columnSurfaceY(spawnX) - 2);
          spawned.push(createZombie(spawnX, spawnY));
        }
        state.pendingThisWave--;
        // Arm the next drip: 0.5x..1.5x the per-wave base gap (intermittent,
        // never metronomic).
        const g = state.spawnGapBase;
        state.ticksToNextSpawn = g + Math.floor((Math.random() - 0.5) * g);
      }
      // Cap reached: ticksToNextSpawn stays <= 0 so we retry on the very next
      // tick. pendingThisWave is NOT decremented - the zombie is deferred, not
      // dropped. Once aliveZombieCount falls below MAX_ZOMBIES the spawner
      // immediately resumes.
    }
  }

  return spawned;
}

/**
 * Returns true once every wave has been launched AND all spawned zombies have
 * been killed. The caller (state.ts / game loop) uses this to trigger the win
 * screen. This function does NOT own the win - it only exposes the signal.
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
