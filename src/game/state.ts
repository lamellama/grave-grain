/**
 * game/state.ts — Win/lose state machine + death watcher (GDD §11, §12.2).
 *
 * Tracks game status (playing / won / lost), the current wave number, how many
 * survivors are alive, and a rolling log of death events. DOM-free; called once
 * per tick from the main loop.
 *
 * WIN  (GDD §11): all WIN_WAVES cleared AND ≥1 survivor still alive.
 * LOSE (GDD §11): every survivor is dead (colony wiped out).
 * LATCH: once 'won' or 'lost', the status never changes again.
 */

import type { Survivor } from '../characters/survivor';
import { allWavesCleared } from './waves';
import type { WaveState } from './waves';
import { WIN_WAVES } from '../config';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** One survivor death (GDD §12.2 — show clear death-cause message). */
export interface DeathEvent {
  cause: string;
  x: number;
  y: number;
  tick: number;
}

/** All game-level state (status, wave mirror, survivor count, log). */
export interface GameState {
  status: 'playing' | 'won' | 'lost';
  wave: number;
  survivorsAlive: number;
  result: string | null;
  deathLog: DeathEvent[];
}

// ---------------------------------------------------------------------------
// Internal tracking — module-level set keyed on Survivor objects so we can
// detect the alive→dead transition without mutating the Survivor.
// WeakSet so garbage-collected survivors don't leak memory.
// ---------------------------------------------------------------------------
const _prevAlive = new WeakSet<Survivor>();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Create the initial (blank) game state. */
export function createGameState(): GameState {
  return {
    status: 'playing',
    wave: 0,
    survivorsAlive: 0,
    result: null,
    deathLog: [],
  };
}

/** Context passed in from the main loop each tick. */
export interface UpdateCtx {
  survivors: Survivor[];
  waveState: WaveState;
  aliveZombieCount: number;
  tick: number;
}

/**
 * Advance the game-state machine by one tick (GDD §11, §12.2).
 *
 * - LATCHES once 'won'/'lost' — never flips back.
 * - Mirrors wave number and alive survivor count.
 * - Death watcher: detects alive→dead transitions and pushes a DeathEvent;
 *   caps the log at the last 8 entries (oldest dropped).
 * - Win: allWavesCleared(waveState, aliveZombieCount) && survivorsAlive > 0.
 * - Lose: survivors.length > 0 && survivorsAlive === 0.
 */
export function updateGameState(state: GameState, ctx: UpdateCtx): void {
  // --- LATCH ---
  if (state.status !== 'playing') return;

  const { survivors, waveState, aliveZombieCount, tick } = ctx;

  // --- Mirror wave number ---
  state.wave = waveState.waveNumber;

  // --- Death watcher (GDD §12.2) ---
  // For every survivor, check whether it has just transitioned alive->dead.
  // We use the WeakSet to track who was alive last tick.
  let lastDeathCause: string | null = null;

  for (const s of survivors) {
    const wasAlive = _prevAlive.has(s);
    const isAlive = s.body.alive;

    if (wasAlive && !isAlive) {
      // Transition: was alive last tick, now dead.
      const cause = s.deathCause ?? 'killed by zombies';
      lastDeathCause = cause;
      const event: DeathEvent = {
        cause,
        x: Math.round(s.body.x),
        y: Math.round(s.body.y),
        tick,
      };
      state.deathLog.push(event);
      // Cap to last 8 entries (drop oldest).
      if (state.deathLog.length > 8) {
        state.deathLog.splice(0, state.deathLog.length - 8);
      }
      // Remove from set so we don't log the same death twice next tick.
      _prevAlive.delete(s);
    } else if (isAlive) {
      // Currently alive: mark as seen-alive for the next tick.
      _prevAlive.add(s);
    }
    // Dead and was already removed (or was never added): nothing to do.
  }

  // --- Mirror survivors alive ---
  const survivorsAlive = survivors.filter(s => s.body.alive).length;
  state.survivorsAlive = survivorsAlive;

  // --- Lose condition (GDD §11) ---
  if (survivors.length > 0 && survivorsAlive === 0) {
    state.status = 'lost';
    const cause = lastDeathCause ?? (state.deathLog.length > 0
      ? state.deathLog[state.deathLog.length - 1].cause
      : 'overrun');
    state.result = 'Colony lost — ' + cause;
    return;
  }

  // --- Win condition (GDD §11) ---
  if (allWavesCleared(waveState, aliveZombieCount) && survivorsAlive > 0) {
    state.status = 'won';
    state.result = 'Survived ' + WIN_WAVES + ' waves';
    return;
  }
}
