/**
 * p9-state — Win/lose state machine + death watcher (task 9-4).
 *
 * Tests (headless, minimal stubs):
 *  1. All-dead → status 'lost', result set.
 *  2. allWavesCleared true + alive survivor → status 'won'.
 *  3. Death watcher: deathCause propagated; null → 'killed by zombies'; no duplicates.
 *  4. Status latches (won/lost never flipped back).
 */

import { createGameState, updateGameState } from '../src/game/state';
import type { GameState } from '../src/game/state';
import type { WaveState } from '../src/game/waves';
import { WIN_WAVES } from '../src/config';

declare const process: any;

let failed = 0;
function assert(cond: boolean, msg: string) {
  if (cond) { console.log('  PASS:', msg); }
  else { console.error('  FAIL:', msg); failed++; }
}

// ---------------------------------------------------------------------------
// Minimal Survivor-like stub (cast as any to satisfy the import type).
// We only need: body.alive, body.x, body.y, deathCause.
// ---------------------------------------------------------------------------
function makeSurvivor(alive: boolean, deathCause: string | null = null): any {
  return { body: { alive, x: 10, y: 20 }, deathCause };
}

// Minimal WaveState stub for win condition (all waves cleared).
function winWaveState(): WaveState {
  return {
    waveNumber: WIN_WAVES,
    ticksToNextWave: 0,
    pendingThisWave: 0,
    ticksToNextSpawn: 0,
    spawnGapBase: 0,
  };
}

// WaveState still in progress.
function playingWaveState(): WaveState {
  return {
    waveNumber: 1,
    ticksToNextWave: 999,
    pendingThisWave: 0,
    ticksToNextSpawn: 0,
    spawnGapBase: 0,
  };
}

// ---------------------------------------------------------------------------
// [1] Lose: all survivors dead (body.alive = false)
// ---------------------------------------------------------------------------
console.log('\n[1] Lose condition');
{
  const gs = createGameState();
  const s1 = makeSurvivor(true);
  const s2 = makeSurvivor(true);
  const ws = playingWaveState();

  // Tick 0 — both alive (registers them in _prevAlive).
  updateGameState(gs, { survivors: [s1, s2], waveState: ws, aliveZombieCount: 2, tick: 0 });
  assert(gs.status === 'playing', 'still playing after tick 0');

  // Kill them both.
  s1.body.alive = false;
  s1.deathCause = 'starvation';
  s2.body.alive = false;
  s2.deathCause = null; // no explicit cause

  // Tick 1 — both now dead → lose.
  updateGameState(gs, { survivors: [s1, s2], waveState: ws, aliveZombieCount: 0, tick: 1 });
  assert(gs.status === 'lost', `status is 'lost' (got '${gs.status}')`);
  assert(gs.result !== null, 'result is set');
  assert(typeof gs.result === 'string' && gs.result.length > 0, `result is non-empty string (got '${gs.result}')`);
  console.log('  result =', gs.result);
}

// ---------------------------------------------------------------------------
// [2] Win: allWavesCleared + alive survivor
// ---------------------------------------------------------------------------
console.log('\n[2] Win condition');
{
  const gs = createGameState();
  const s = makeSurvivor(true);
  const ws = playingWaveState();

  // Tick 0 — register survivor as alive.
  updateGameState(gs, { survivors: [s], waveState: ws, aliveZombieCount: 0, tick: 0 });
  assert(gs.status === 'playing', 'playing before waves cleared');

  // Now set waveState to cleared (WIN_WAVES done, no pending, no alive zombies).
  const wsDone = winWaveState();

  // Tick 1 — win.
  updateGameState(gs, { survivors: [s], waveState: wsDone, aliveZombieCount: 0, tick: 1 });
  assert(gs.status === 'won', `status is 'won' (got '${gs.status}')`);
  assert(gs.result !== null && gs.result.includes(String(WIN_WAVES)), `result mentions WIN_WAVES (got '${gs.result}')`);
  console.log('  result =', gs.result);
}

// ---------------------------------------------------------------------------
// [3] Death watcher
// ---------------------------------------------------------------------------
console.log('\n[3] Death watcher');
{
  // 3a. deathCause='thirst' → cause in log = 'thirst'
  {
    const gs = createGameState();
    const s = makeSurvivor(true);
    const ws = playingWaveState();

    // Register alive tick 0.
    updateGameState(gs, { survivors: [s], waveState: ws, aliveZombieCount: 0, tick: 0 });

    // Kill with explicit cause.
    s.body.alive = false;
    s.deathCause = 'thirst';

    // Tick 1 — death detected.
    updateGameState(gs, { survivors: [s], waveState: ws, aliveZombieCount: 0, tick: 1 });

    assert(gs.deathLog.length === 1, `exactly 1 death-log entry (got ${gs.deathLog.length})`);
    assert(gs.deathLog[0].cause === 'thirst', `cause = 'thirst' (got '${gs.deathLog[0].cause}')`);

    // Tick 2 — same dead survivor, no duplicate entry.
    // (status is now 'lost' so updateGameState latches — reset status for this sub-test)
    const gs2 = createGameState();
    const s2 = makeSurvivor(true);
    updateGameState(gs2, { survivors: [s2], waveState: ws, aliveZombieCount: 0, tick: 0 });
    s2.body.alive = false;
    s2.deathCause = 'thirst';
    updateGameState(gs2, { survivors: [s2], waveState: ws, aliveZombieCount: 0, tick: 1 });
    // Add a 2nd alive survivor to keep 'playing' state after first death...
    // Actually with one survivor that's dead the status goes to 'lost' after tick 1.
    // To test no-duplicate we need to check with a multi-survivor setup. Let's test
    // that calling update again (latched as lost) doesn't add more entries.
    const logLenBeforeRetick = gs2.deathLog.length;
    updateGameState(gs2, { survivors: [s2], waveState: ws, aliveZombieCount: 0, tick: 2 });
    assert(gs2.deathLog.length === logLenBeforeRetick, 'no duplicate on subsequent tick (latched)');
  }

  // 3b. deathCause=null → cause = 'killed by zombies'
  {
    const gs = createGameState();
    const s = makeSurvivor(true);
    const ws = playingWaveState();

    updateGameState(gs, { survivors: [s], waveState: ws, aliveZombieCount: 0, tick: 0 });
    s.body.alive = false;
    s.deathCause = null;

    updateGameState(gs, { survivors: [s], waveState: ws, aliveZombieCount: 0, tick: 1 });
    assert(
      gs.deathLog.length === 1 && gs.deathLog[0].cause === 'killed by zombies',
      `null deathCause → 'killed by zombies' (got '${gs.deathLog[0]?.cause}')`
    );
  }

  // 3c. No-duplicate: two ticks after a survivor is already dead don't re-log.
  {
    // Two survivors: kill one on tick1, then call again on tick2 while still 'playing'
    // (second survivor is alive to keep status='playing').
    const gs = createGameState();
    const alive = makeSurvivor(true);
    const dying = makeSurvivor(true);
    const ws = playingWaveState();

    // Tick 0 — both alive.
    updateGameState(gs, { survivors: [alive, dying], waveState: ws, aliveZombieCount: 0, tick: 0 });

    // Kill dying.
    dying.body.alive = false;
    dying.deathCause = 'starvation';

    // Tick 1 — dying goes dead, log gets one entry, status stays 'playing' (alive is up).
    updateGameState(gs, { survivors: [alive, dying], waveState: ws, aliveZombieCount: 0, tick: 1 });
    assert(gs.deathLog.length === 1, 'one entry after first death tick');
    assert(gs.status === 'playing', 'still playing (1 survivor alive)');

    // Tick 2 — same dead survivor, should NOT get another entry.
    updateGameState(gs, { survivors: [alive, dying], waveState: ws, aliveZombieCount: 0, tick: 2 });
    assert(gs.deathLog.length === 1, 'no duplicate on second tick after death');
  }
}

// ---------------------------------------------------------------------------
// [4] Status latches
// ---------------------------------------------------------------------------
console.log('\n[4] Latch');
{
  // 4a. won → stays won even when conditions reverse.
  {
    const gs = createGameState();
    const s = makeSurvivor(true);
    const wsDone = winWaveState();

    // Tick 0 to register.
    updateGameState(gs, { survivors: [s], waveState: playingWaveState(), aliveZombieCount: 0, tick: 0 });
    // Tick 1 — win.
    updateGameState(gs, { survivors: [s], waveState: wsDone, aliveZombieCount: 0, tick: 1 });
    assert(gs.status === 'won', 'status is won');

    // Kill the survivor and try a tick — should still be won.
    s.body.alive = false;
    const resultBefore = gs.result;
    updateGameState(gs, { survivors: [s], waveState: wsDone, aliveZombieCount: 0, tick: 2 });
    assert(gs.status === 'won', 'latch: status stays won after survivor dies');
    assert(gs.result === resultBefore, 'latch: result unchanged');
  }

  // 4b. lost → stays lost even when we pass a win-looking context.
  {
    const gs = createGameState();
    const s = makeSurvivor(true);
    const ws = playingWaveState();

    updateGameState(gs, { survivors: [s], waveState: ws, aliveZombieCount: 0, tick: 0 });
    s.body.alive = false;
    s.deathCause = 'starvation';
    updateGameState(gs, { survivors: [s], waveState: ws, aliveZombieCount: 0, tick: 1 });
    assert(gs.status === 'lost', 'status is lost');

    const resultBefore = gs.result;
    // Try to win: pass a cleared waveState with an alive survivor somehow.
    updateGameState(gs, { survivors: [makeSurvivor(true)], waveState: winWaveState(), aliveZombieCount: 0, tick: 2 });
    assert(gs.status === 'lost', 'latch: status stays lost');
    assert(gs.result === resultBefore, 'latch: result unchanged');
  }
}

// ---------------------------------------------------------------------------
console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
